// 관리자 ▸ 시스템 ▸ 개인 브레인 이전: moving every teammate's personal brain
// notes from their knowledge repository to the memory service
// (GET /api/admin/personal-vaults + dry-run / mode / run / :userId/rollback).
//
// The server decides everything; this panel shows what it says and asks before
// each step that changes where somebody's notes live. A refusal is shown as the
// server phrased it. Always mounted by AdminView with an `active` prop.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./AdminPersonalVaultPanel.css";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { formatFileSize, timeLabel } from "../lib/format";
import { cx } from "../lib/hooks";
import {
  VAULT_OWNER_STATE_LABELS,
  readAdminPersonalVaults,
  vaultBlockerText,
  vaultHasLeftoverCopy,
  vaultMirrorAdminNoticeText,
  vaultMirrorCellText,
  vaultMirrorKind,
  vaultSkippedReasonText,
  type AdminPersonalVaults,
  type AdminVaultOwner,
  type VaultHome,
  type VaultMigrationReport,
} from "../lib/personalVault";

export interface AdminPersonalVaultPanelProps {
  active?: boolean;
}

/** How often the table is read again while a pass is running. */
const RUNNING_POLL_MS = 3000;

const headingId = "admin-personal-vault-heading";
const statusId = "admin-personal-vault-status";

const MODES: { id: VaultHome; label: string; desc: string }[] = [
  {
    id: "repo",
    label: "저장소에 보관",
    desc: "새로 옮기지 않습니다. 아직 옮기지 않은 팀원의 브레인 노트는 지금처럼 각자의 지식 저장소에 있고, 이미 옮긴 팀원은 메모리 서비스에 그대로 남습니다.",
  },
  {
    id: "memory",
    label: "메모리 서비스로 이전",
    desc: "지식 저장소를 연결한 팀원의 브레인 노트를 한 명씩 메모리 서비스로 옮깁니다. 나중에 저장소를 연결하거나 바꾸는 팀원도 그때 옮겨집니다.",
  },
];

function ownerName(owner: AdminVaultOwner): string {
  return owner.displayName || owner.username || owner.userId;
}

/**
 * State that a continuation running LATER (after an `await`) reads as it is
 * now: the ref is written together with the state, not at the next render.
 */
function useLive<T>(initial: T): [T, (next: T) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useRef((next: T): void => {
    ref.current = next;
    setValue(next);
  });
  return [value, set.current, ref];
}

function ReportDetail({
  owner,
  report,
  canAct,
  disabled,
  busy,
  onDiscard,
}: {
  owner: AdminVaultOwner;
  report: VaultMigrationReport;
  /** The memory service is configured: without it the way out cannot be carried out, so it is not offered. */
  canAct: boolean;
  disabled: boolean;
  busy: boolean;
  onDiscard: () => void;
}) {
  const moved = owner.state === "memory";
  // The way out of "the service still holds something": discard that leftover copy.
  const leftover = canAct && owner.state === "repo" && vaultHasLeftoverCopy(report);
  // The report is the LAST look (a dry run or a cutover), not the state now: it says when it was made.
  const madeAt = timeLabel(report.at);
  const lookFailed = moved && report.blockers.length > 0;
  return (
    <div className="vault-report">
      {report.state === "no_repo" ? (
        <span className="muted">
          {madeAt ? `${madeAt}에 확인 · ` : ""}연결된 저장소가 없어 옮길 노트가 없습니다.
        </span>
      ) : (
        <span>
          {madeAt ? <span className="muted">{madeAt}에 확인{lookFailed ? "" : " · "}</span> : null}
          {/* A moved owner's look that failed counted nothing: no "0개" that would read as an empty brain. */}
          {lookFailed ? null : (
            <>
              {moved ? "옮긴 노트" : "옮길 노트"} {report.notes}개 · {formatFileSize(report.bytes) || "0 B"}
            </>
          )}
        </span>
      )}
      {report.blockers.length ? (
        <div className="vault-report-blockers">
          {/* An owner already moved is not waiting to be moved: the look itself could not be made. */}
          <strong>{moved ? "확인하지 못했습니다." : "아직 옮길 수 없습니다."}</strong>
          <ul>
            {report.blockers.map((blocker, i) => (
              <li key={i}>{vaultBlockerText(blocker)}</li>
            ))}
          </ul>
          {leftover ? (
            <button className="ghost-sm danger" type="button" disabled={disabled} aria-label={`${ownerName(owner)} 남은 사본 비우기`} onClick={onDiscard}>
              {busy ? "비우는 중…" : "메모리 서비스에 남은 사본 비우기"}
            </button>
          ) : null}
        </div>
      ) : null}
      {report.skipped.length ? (
        <details className="vault-report-skipped">
          <summary>저장소에 그대로 남는 파일 {report.skipped.length}개</summary>
          <ul>
            {report.skipped.map((entry, i) => (
              <li key={i}>
                <code>{entry.path}</code> — {vaultSkippedReasonText(entry.reason)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export default function AdminPersonalVaultPanel({ active = false }: AdminPersonalVaultPanelProps) {
  const initialized = useRef(false);
  const [data, setData, dataRef] = useLive<AdminPersonalVaults | null>(null);
  const [busy, setBusy, busyRef] = useLive(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [rollbackId, setRollbackId] = useState("");
  // Bumped after every background read, so the next one is scheduled even when the read failed.
  const [pollTick, setPollTick] = useState(0);

  const running = Boolean(data?.running);
  const owners = data?.owners ?? [];
  const movedCount = owners.filter((owner) => owner.state === "memory").length;
  const connectedCount = owners.filter((owner) => owner.state !== "no_repo").length;

  async function read(): Promise<AdminPersonalVaults> {
    const next = readAdminPersonalVaults(await api<unknown>("/api/admin/personal-vaults"));
    if (!next) throw new Error("개인 브레인 이전 상태를 불러오지 못했습니다.");
    return next;
  }

  /** Take the server's state; a pass that was running and no longer is says so. */
  function apply(next: AdminPersonalVaults): void {
    if (dataRef.current?.running && !next.running) setMessage("이전 실행이 끝났습니다. 팀원별 결과는 아래 표에 있습니다.");
    setData(next);
  }

  async function load(): Promise<void> {
    initialized.current = true;
    if (busyRef.current) return;
    setBusy(true);
    setError("");
    try {
      apply(await read());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A layout effect, so the first paint of the tab already says it is loading.
  useLayoutEffect(() => {
    if (active && !initialized.current) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // While a pass runs the table follows it; a read that fails keeps what is shown and tries again.
  useEffect(() => {
    if (!active || !running) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (!busyRef.current) apply(await read());
        } catch {
          /* keep what we have */
        } finally {
          setPollTick((n) => n + 1);
        }
      })();
    }, RUNNING_POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, running, pollTick]);

  /**
   * One admin action: its message or the server's refusal, then the table as
   * the server has it now — also after a refusal, which means the screen was
   * out of date (a 409: the owner is no longer where this screen showed them).
   */
  async function run(fn: () => Promise<string>, options: { refresh?: boolean } = {}): Promise<void> {
    if (busyRef.current) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (options.refresh !== false) {
        try {
          apply(await read());
        } catch {
          /* keep what we have */
        }
      }
      setBusy(false);
    }
  }

  /** The server just started a pass: a read that already finds it finished then reports the end, not the start. */
  function markRunning(): void {
    const current = dataRef.current;
    if (current && !current.running) setData({ ...current, running: true });
  }

  async function switchMode(mode: VaultHome): Promise<void> {
    const current = dataRef.current;
    if (!current || busyRef.current || current.mode === mode) return;
    const confirmed =
      mode === "memory"
        ? await confirmAction(
            "보관 방식을 ‘메모리 서비스로 이전’으로 바꾸면 바로 이전을 시작합니다.\n" +
              "• 지식 저장소를 연결한 팀원을 한 명씩 옮깁니다. 옮길 수 없는 팀원은 건너뛰고, 그 사유를 아래 표에 보여 줍니다.\n" +
              "• 옮긴 노트는 하나씩 다시 읽어 저장소의 파일과 비교합니다. 한 사람의 노트가 모두 일치할 때만 그 사람을 전환하고, 하나라도 다르면 지금처럼 저장소에 그대로 둡니다.\n" +
              "• 저장소의 파일은 지우지 않습니다. 옮긴 뒤에는 저장소에 사본이 계속 올라갑니다.\n" +
              "• 옮긴 팀원은 노트를 쓰는 즉시 저장됩니다(커밋을 기다리지 않습니다).",
            { title: "메모리 서비스로 이전을 시작할까요?", confirmLabel: "이전 시작" },
          )
        : await confirmAction(
            "보관 방식을 ‘저장소에 보관’으로 바꾸면 아직 옮기지 않은 팀원을 더 이상 옮기지 않습니다.\n" +
              "이미 옮긴 팀원은 되돌리지 않습니다. 메모리 서비스에 그대로 남고 저장소에 사본도 계속 올라갑니다.\n" +
              "되돌리려면 아래 표에서 한 명씩 ‘되돌리기’를 눌러 주세요.",
            { title: "새로 옮기는 것을 멈출까요?", confirmLabel: "멈추기" },
          );
    if (!confirmed) return;
    await run(async () => {
      const result = await api<{ mode: VaultHome; started?: boolean }>("/api/admin/personal-vaults/mode", {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      if (result.mode === "memory") {
        if (result.started) markRunning();
        return result.started ? "보관 방식을 바꾸고 이전을 시작했습니다." : "보관 방식을 바꿨습니다. 이미 이전이 진행 중입니다.";
      }
      return "보관 방식을 바꿨습니다. 새로 옮기지 않습니다.";
    });
  }

  const dryRun = () =>
    run(
      async () => {
        const { reports } = await api<{ reports: VaultMigrationReport[] }>("/api/admin/personal-vaults/dry-run", { method: "POST" });
        const list = Array.isArray(reports) ? reports : [];
        const byUser = new Map(list.map((report) => [report.userId, report]));
        const current = dataRef.current;
        // The reports are shown at once, under each owner; nothing was moved.
        if (current) {
          setData({ ...current, owners: current.owners.map((owner) => ({ ...owner, report: byUser.get(owner.userId) ?? owner.report })) });
        }
        const movable = list.filter((report) => report.state === "repo" && !report.blockers.length).length;
        const blocked = list.filter((report) => report.state === "repo" && report.blockers.length).length;
        return `미리 확인을 마쳤습니다. 옮길 수 있는 팀원 ${movable}명, 아직 옮길 수 없는 팀원 ${blocked}명. 아무것도 바뀌지 않았습니다.`;
      },
      { refresh: false },
    );

  const runPass = () =>
    run(async () => {
      const { started } = await api<{ started?: boolean }>("/api/admin/personal-vaults/run", { method: "POST" });
      if (started) markRunning();
      return started ? "이전을 시작했습니다." : "이미 이전이 진행 중입니다.";
    });

  async function rollback(owner: AdminVaultOwner): Promise<void> {
    const current = dataRef.current;
    if (!current || busyRef.current) return;
    const name = ownerName(owner);
    const confirmed = await confirmAction(
      `${name}님의 브레인 노트를 저장소 보관으로 되돌립니다.\n` +
        "1. 먼저 저장소의 사본을 최신으로 맞춥니다. 맞추지 못하면 되돌리지 않고 이유를 알려 줍니다.\n" +
        "2. 그다음부터 이 팀원의 노트는 다시 저장소에서 읽고 씁니다.\n" +
        "3. 메모리 서비스에 있던 이 팀원의 노트는 지웁니다. 같은 내용이 모두 저장소에 있습니다." +
        (current.mode === "memory" ? "\n보관 방식이 ‘메모리 서비스로 이전’인 동안에는 다음 이전 때 이 팀원이 다시 옮겨집니다." : ""),
      { title: "저장소 보관으로 되돌릴까요?", confirmLabel: "되돌리기", tone: "danger" },
    );
    if (!confirmed) return;
    setRollbackId(owner.userId);
    try {
      await run(async () => {
        // `expect`: the server refuses when this owner is no longer on the memory service (a stale screen).
        await api(`/api/admin/personal-vaults/${encodeURIComponent(owner.userId)}/rollback`, {
          method: "POST",
          body: JSON.stringify({ expect: "memory" }),
        });
        return `${name}님의 브레인 노트를 저장소 보관으로 되돌렸습니다.`;
      });
    } finally {
      setRollbackId("");
    }
  }

  /** An owner still on the repository whose earlier import left a copy in the service: discard that copy. */
  async function discardLeftover(owner: AdminVaultOwner): Promise<void> {
    if (!dataRef.current || busyRef.current) return;
    const name = ownerName(owner);
    const confirmed = await confirmAction(
      `${name}님의 브레인 노트는 지금 저장소에 있고, 저장소의 노트는 바뀌지 않습니다.\n` +
        "메모리 서비스에 남아 있는 이 팀원의 이전 사본을 지웁니다. 그 사본에만 있거나 저장소와 내용이 다른 노트는 지우기 전에 서버에 따로 보관해 두므로 운영자가 복구할 수 있습니다.\n" +
        "지운 뒤 ‘미리 확인’이나 ‘이전 실행’을 다시 하면 저장소의 노트로 새로 옮깁니다.",
      { title: "메모리 서비스에 남은 사본을 비울까요?", confirmLabel: "비우기", tone: "danger" },
    );
    if (!confirmed) return;
    setRollbackId(owner.userId);
    try {
      // The table is read again afterwards: the server drops the report that named the leftover.
      await run(async () => {
        // `expect`: the server refuses when this owner has been moved meanwhile — this press must never roll them back.
        await api(`/api/admin/personal-vaults/${encodeURIComponent(owner.userId)}/rollback`, {
          method: "POST",
          body: JSON.stringify({ expect: "repo" }),
        });
        return `${name}님의 메모리 서비스에 남은 사본을 비웠습니다. ‘미리 확인’으로 다시 확인해 주세요.`;
      });
    } finally {
      setRollbackId("");
    }
  }

  if (!active) return null;

  const locked = busy || running;
  // Without the memory service nothing here can be carried out: the table is shown, no action is offered.
  const configured = Boolean(data?.serviceConfigured);
  const statusText = running
    ? "이전을 진행하고 있습니다… 표는 자동으로 새로 고칩니다."
    : busy
      ? "처리 중…"
      : message
        ? message
        : `옮긴 팀원 ${movedCount}명 / 저장소를 연결한 팀원 ${connectedCount}명`;

  return (
    <section className="settings-card cmp-admin-personal-vault-panel" aria-labelledby={headingId} aria-busy={busy || running}>
      <div className="panel-section-head">
        <div>
          <h3 id={headingId}>개인 브레인 이전</h3>
          <p className="muted">
            팀원 각자의 브레인 노트(지식 저장소 맨 위의 CLAUDE.md와 wiki/, raw/ 안의 .md 파일)를 메모리 서비스로 옮깁니다. 옮긴 뒤에도 저장소의
            파일은 지우지 않고, 저장소에는 사본이 계속 올라갑니다. 팀 브레인은 대상이 아닙니다.
          </p>
        </div>
        <button className="ghost-sm" type="button" disabled={busy} onClick={() => void load()}>
          새로 고침
        </button>
      </div>

      {data && !data.serviceConfigured ? (
        movedCount > 0 ? (
          <p className="warn-box vault-admin-unconfigured" role="alert">
            이 서버에는 메모리 서비스가 설정되어 있지 않습니다. 메모리 서비스로 옮긴 팀원 {movedCount}명의 브레인 노트는 서비스가 다시 설정될
            때까지 읽을 수도 쓸 수도 없습니다. 서버 환경 변수 PI_MEMORY_URL과 PI_MEMORY_API_KEY_FILE을 다시 설정하고 배포해 주세요. 그때까지
            이 화면에서 할 수 있는 작업은 없습니다.
          </p>
        ) : (
          <p className="warn-box vault-admin-unconfigured" role="note">
            이 서버에는 메모리 서비스가 설정되어 있지 않습니다. 옮긴 팀원이 없어 모든 팀원의 브레인 노트는 각자의 지식 저장소에 있습니다. 서버
            환경 변수 PI_MEMORY_URL과 PI_MEMORY_API_KEY_FILE을 설정하고 다시 배포하면 여기에서 이전을 시작할 수 있습니다.
          </p>
        )
      ) : data ? (
        <>
          <h4 className="vault-admin-sub">보관 방식</h4>
          <div className="radio-cards" role="radiogroup" aria-label="개인 브레인 보관 방식" aria-describedby={statusId}>
            {MODES.map((mode) => (
              <label className="radio-card" htmlFor={`vault-mode-${mode.id}`} key={mode.id}>
                <input
                  type="radio"
                  name="personal-vault-mode"
                  id={`vault-mode-${mode.id}`}
                  value={mode.id}
                  // The saved mode stays checked until the server says it changed (the click only asks).
                  checked={data.mode === mode.id}
                  disabled={busy}
                  onChange={() => void switchMode(mode.id)}
                />
                <div className="radio-card-body">
                  <strong>{mode.label}</strong>
                  <div className="muted">{mode.desc}</div>
                </div>
              </label>
            ))}
          </div>

          <div className="settings-save-row">
            <span id={statusId} className={cx("settings-save-status", (busy || running) && "pending")} role="status" aria-live="polite">
              {statusText}
            </span>
            <div className="vault-admin-actions">
              <button
                className="ghost-sm"
                type="button"
                disabled={locked}
                title="아무것도 옮기지 않고, 옮길 노트와 옮길 수 없는 사유만 확인합니다"
                onClick={() => void dryRun()}
              >
                미리 확인
              </button>
              <button className="primary" type="button" disabled={locked || data.mode !== "memory"} onClick={() => void runPass()}>
                {running ? "이전 중…" : "이전 실행"}
              </button>
            </div>
          </div>
          {data.mode !== "memory" ? (
            <p className="muted vault-admin-hint">이전을 실행하려면 먼저 보관 방식을 ‘메모리 서비스로 이전’으로 바꿔 주세요. ‘미리 확인’은 지금도 쓸 수 있습니다.</p>
          ) : null}
        </>
      ) : busy ? (
        <p className="muted" role="status">
          불러오는 중…
        </p>
      ) : null}

      {error && (
        <p className="warn-box" role="alert">
          {error}
        </p>
      )}

      {data ? (
        owners.length ? (
          <div className="vault-table-wrap">
            <table className="vault-table" aria-label="팀원별 개인 브레인 보관 상태">
              <thead>
                <tr>
                  <th scope="col">팀원</th>
                  <th scope="col">보관 위치</th>
                  <th scope="col">저장소</th>
                  <th scope="col">옮긴 때</th>
                  <th scope="col">저장소 사본</th>
                  <th scope="col">
                    <span className="sr-only">작업</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {owners.map((owner) => {
                  const mirrorKind = owner.mirror ? vaultMirrorKind(owner.mirror) : null;
                  const notice = owner.state === "memory" ? owner.mirror?.notice : null;
                  return (
                    <Fragment key={owner.userId}>
                      <tr className={cx((owner.report || notice) && "has-report")}>
                        <th scope="row" data-label="팀원">
                          <span className="vault-owner-name">{ownerName(owner)}</span>{" "}
                          {owner.username && owner.username !== ownerName(owner) ? <span className="muted">@{owner.username}</span> : null}
                        </th>
                        <td data-label="보관 위치">
                          <span className={cx("tag", owner.state === "memory" && configured && "ok")}>
                            {VAULT_OWNER_STATE_LABELS[owner.state] || owner.state}
                          </span>
                          {owner.state === "memory" && !configured ? (
                            <>
                              {" "}
                              <span className="tag danger">읽기·쓰기 불가</span>
                            </>
                          ) : null}
                        </td>
                        <td data-label="저장소">{owner.repo ? <code>{owner.repo}</code> : <span className="muted">—</span>}</td>
                        <td className="vault-cell-when" data-label="옮긴 때">{timeLabel(owner.migratedAt) || <span className="muted">—</span>}</td>
                        <td className="vault-cell-mirror" data-label="저장소 사본">
                          <span
                            className={cx(
                              mirrorKind === "failed" && "vault-cell-failed",
                              mirrorKind === "confirm" && "vault-cell-hold",
                              !owner.mirror && "muted",
                            )}
                            title={owner.mirror?.error || undefined}
                          >
                            {owner.state === "memory" && !owner.repo ? "저장소 없음 · 사본을 올릴 곳이 없음" : vaultMirrorCellText(owner.mirror)}
                          </span>
                        </td>
                        <td className="vault-cell-action">
                          {owner.state === "memory" && configured ? (
                            <button
                              className="ghost-sm danger"
                              type="button"
                              disabled={locked}
                              aria-label={`${ownerName(owner)} 되돌리기`}
                              onClick={() => void rollback(owner)}
                            >
                              {rollbackId === owner.userId ? "되돌리는 중…" : "되돌리기"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {owner.report || notice ? (
                        <tr className="vault-report-row">
                          <td colSpan={6}>
                            {notice ? (
                              <div className="vault-notice" role="note">
                                {vaultMirrorAdminNoticeText(notice, configured)}
                              </div>
                            ) : null}
                            {owner.report ? (
                              <ReportDetail
                                owner={owner}
                                report={owner.report}
                                canAct={configured}
                                disabled={locked}
                                busy={rollbackId === owner.userId}
                                onDiscard={() => void discardLeftover(owner)}
                              />
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-note">아직 팀원이 없습니다.</div>
        )
      ) : null}
    </section>
  );
}
