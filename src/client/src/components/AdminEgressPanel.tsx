import { useLayoutEffect, useRef, useState } from "react";
import "./AdminEgressPanel.css";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { cx } from "../lib/hooks";
import { normalizeEgressDomains } from "../../../shared/egressDomains";
import type { EgressPolicyState } from "../../../server/types";

export interface AdminEgressPanelProps {
  active?: boolean;
}

export default function AdminEgressPanel({ active = false }: AdminEgressPanelProps) {
  const initialized = useRef(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<EgressPolicyState | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [includeSubdomains, setIncludeSubdomains] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [statusUnconfirmed, setStatusUnconfirmed] = useState(false);
  const dirty = !!state && JSON.stringify(domains) !== JSON.stringify(state.domains);

  async function load() {
    initialized.current = true;
    if (busy) return;
    if (dirty && !(await confirmAction("수정 중인 목록을 버리고 현재 적용된 목록을 불러올까요?"))) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await api<EgressPolicyState>("/api/admin/egress");
      setState(next);
      setDomains([...next.domains]);
      setStatusUnconfirmed(false);
    } catch (err) {
      setError((err as Error).message);
      setStatusUnconfirmed(true);
    } finally {
      setBusy(false);
    }
  }

  // A layout effect, so the first paint of the tab already says it is loading.
  useLayoutEffect(() => {
    if (active && !initialized.current) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function add() {
    setError("");
    setMessage("");
    try {
      const value = domainInput.trim();
      const candidate = includeSubdomains && !value.startsWith(".") && !value.startsWith("*.") ? `.${value}` : value;
      setDomains(normalizeEgressDomains([...domains, candidate]));
      setDomainInput("");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function remove(domain: string) {
    setDomains(domains.filter((value) => value !== domain));
    setError("");
    setMessage("");
  }

  async function save() {
    if (busy || !state?.configured || !state.revision) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await api<EgressPolicyState>("/api/admin/egress", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Noah-Egress-Admin": "1" },
        body: JSON.stringify({ domains, revision: state.revision }),
      });
      setState(next);
      setDomains([...next.domains]);
      setStatusUnconfirmed(false);
      setMessage("전체 아바타에 차단 목록을 적용했습니다.");
    } catch (err) {
      setError((err as Error).message);
      setStatusUnconfirmed(true);
    } finally {
      setBusy(false);
    }
  }

  if (!active) return null;

  return (
    <section className="settings-card egress-card cmp-admin-egress-panel" aria-labelledby="egress-heading" aria-busy={busy}>
      <div className="panel-section-head">
        <div>
          <h3 id="egress-heading">외부 통신 차단</h3>
          <p className="muted">전체 아바타의 서버 요청에 공통 적용됩니다. 사용자 PC의 브라우저 도구는 적용 대상이 아닙니다.</p>
        </div>
        <button className="ghost-sm" type="button" disabled={busy} onClick={() => void load()}>
          현재 목록 불러오기
        </button>
      </div>
      {state?.configured ? (
        <>
          <p className="muted" role="status">
            {statusUnconfirmed
              ? "현재 적용 상태를 확인하려면 목록을 다시 불러오세요."
              : state.proxyReady
                ? "차단 서비스 작동 중"
                : "차단 서비스 연결 확인 필요 — 외부 요청이 실패할 수 있습니다."}{" "}
            {state.appliedAt && <> · 마지막 적용 {new Date(state.appliedAt).toLocaleString("ko-KR")}</>}
          </p>
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <label className="field">
              <span>차단할 도메인</span>
              <input
                value={domainInput}
                onChange={(event) => setDomainInput(event.currentTarget.value)}
                placeholder="example.com"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                aria-describedby="egress-help"
              />
            </label>
            <div className="egress-add-row">
              <label>
                <input
                  type="checkbox"
                  checked={includeSubdomains}
                  onChange={(event) => setIncludeSubdomains(event.currentTarget.checked)}
                  disabled={busy}
                />{" "}
                하위 도메인도 포함
              </label>
              <button className="ghost-sm" type="submit" disabled={busy || !domainInput.trim()}>
                목록에 추가
              </button>
            </div>
            <p id="egress-help" className="muted">
              URL 경로와 IP 주소는 지원하지 않습니다. 상위 도메인 규칙에 포함되는 중복 항목은 합쳐집니다.
            </p>
          </form>
          <ul className="egress-domains" aria-label="차단 도메인 목록">
            {domains.map((domain) => (
              <li key={domain}>
                <div>
                  <strong>{domain.replace(/^\./, "")}</strong>
                  <span className="muted">{domain.startsWith(".") ? "하위 도메인 포함" : "이 호스트만"}</span>
                </div>
                <button className="ghost-sm" type="button" disabled={busy} aria-label={`${domain} 삭제`} onClick={() => remove(domain)}>
                  삭제
                </button>
              </li>
            ))}
          </ul>
          {!domains.length && (
            <p className="empty-note">
              차단할 도메인이 없습니다. 적용하면 도메인 차단을 모두 해제합니다. 직접 IP·DNS 연결 차단은 유지됩니다.
            </p>
          )}
          <p className="muted">
            저장하고 적용하면 진행 중인 서버 외부 연결이 끊어질 수 있습니다. 모델 API·Git·사내 서비스도 이 목록의 영향을 받습니다.
          </p>
          <div className="settings-save-row">
            <span className={cx("settings-save-status", dirty && "dirty", busy && "pending")} role="status" aria-live="polite">
              {busy ? "처리 중…" : message || (dirty ? "아직 적용하지 않은 변경이 있습니다." : `${domains.length}개 도메인 규칙`)}
            </span>
            <button
              className="primary"
              type="button"
              disabled={busy || statusUnconfirmed || (!dirty && state.proxyReady) || !!domainInput.trim()}
              onClick={() => void save()}
            >
              {busy ? "적용 중…" : "저장하고 적용"}
            </button>
          </div>
          {domainInput.trim() && <p className="muted">입력한 도메인을 먼저 목록에 추가하거나 입력을 지워 주세요.</p>}
        </>
      ) : state ? (
        <p className="empty-note">
          이 서버에는 외부 통신 차단 서비스가 연결되어 있지 않습니다. 운영자가 차단 서비스를 설치하면 이 화면에서 목록을 관리할 수 있습니다.
        </p>
      ) : busy ? (
        <p className="muted" role="status">
          차단 정책을 불러오는 중…
        </p>
      ) : null}
      {error && (
        <p className="warn-box" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
