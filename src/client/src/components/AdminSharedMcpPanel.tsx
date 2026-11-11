import { useLayoutEffect, useRef, useState } from "react";
import "./AdminSharedMcpPanel.css";
import Icon from "./Icon";
import RevealableInput from "./RevealableInput";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { cx } from "../lib/hooks";
import { notify } from "../lib/state";
import type { SharedMcpServerView, SharedMcpTransport } from "../lib/types";

export interface AdminSharedMcpPanelProps {
  active?: boolean;
}

type HeaderDraft = { name: string; value: string };
type SlotDraft = { id: string; label: string; header: string; format: string };
type CheckResult = { ok: boolean; tools: string[]; missingSecrets: string[]; error: string | null };

const formStatusId = "shared-mcp-form-status";

export default function AdminSharedMcpPanel({ active = false }: AdminSharedMcpPanelProps) {
  const [servers, setServers] = useState<SharedMcpServerView[]>([]);
  const [loading, setLoadingState] = useState(false);
  // What load() itself checks: it is also called from continuations that run
  // after an `await`, which must see the flag as it is then.
  const loadingRef = useRef(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState("");
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowStatus, setRowStatus] = useState<Record<string, string>>({});

  // Inline editor: null = closed, "" = new server, otherwise the edited name.
  const [editingName, setEditingName] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<SharedMcpTransport>("http");
  const [enabled, setEnabled] = useState(true);
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);
  // Credential slots: WHERE a user's secret goes. Users pick the secret
  // themselves in their 시크릿 card; the admin never names one. `id` is empty
  // for a new slot (the server mints it) and kept for an existing one, so
  // users' bindings survive an edit.
  const [slots, setSlots] = useState<SlotDraft[]>([]);

  const isEdit = editingName !== null && editingName !== "";
  const editedOrigin = (() => {
    try {
      return new URL(url.trim()).origin;
    } catch {
      return "";
    }
  })();
  const savedOrigin = isEdit ? (servers.find((server) => server.name === editingName)?.origin ?? "") : "";
  const originChanges = Boolean(isEdit && savedOrigin && editedOrigin && editedOrigin !== savedOrigin);
  // Header names repeat case-insensitively across fixed headers AND slots
  // (the server refuses that too; catching it here keeps a row from being
  // silently overwritten in the payload map).
  const duplicateHeader = (() => {
    const seen = new Set<string>();
    for (const headerName of [...headers.map((h) => h.name), ...slots.map((slot) => slot.header)]) {
      const key = headerName.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) return headerName.trim();
      seen.add(key);
    }
    return "";
  })();
  const formReady = Boolean(name.trim() && url.trim() && !formBusy && !duplicateHeader);

  function setLoading(next: boolean): void {
    loadingRef.current = next;
    setLoadingState(next);
  }

  async function load(): Promise<void> {
    if (loadingRef.current) return;
    setLoading(true);
    setError("");
    try {
      setServers((await api<{ servers: SharedMcpServerView[] }>("/api/admin/shared-mcp-servers")).servers);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setInitialized(true);
    }
  }

  // A layout effect, so the first paint of the tab already says it is loading.
  useLayoutEffect(() => {
    if (active && !initialized && !loading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, initialized, loading]);

  function openCreate(): void {
    setEditingName("");
    setName("");
    setLabel("");
    setDescription("");
    setUrl("");
    setTransport("http");
    setEnabled(true);
    setHeaders([]);
    setSlots([{ id: "", label: "API 토큰", header: "Authorization", format: "Bearer {secret}" }]);
    setFormError("");
  }

  function openEdit(server: SharedMcpServerView): void {
    setEditingName(server.name);
    setName(server.name);
    setLabel(server.label);
    setDescription(server.description);
    setUrl(server.url);
    setTransport(server.transport);
    setEnabled(server.enabled);
    setHeaders(Object.entries(server.headers).map(([headerName, value]) => ({ name: headerName, value })));
    setSlots(server.secretSlots.map((slot) => ({ ...slot })));
    setFormError("");
  }

  function closeForm(): void {
    if (formBusy) return;
    setEditingName(null);
  }

  function addHeader(): void {
    setHeaders([...headers, { name: "", value: "" }]);
  }

  function removeHeader(index: number): void {
    setHeaders(headers.filter((_, i) => i !== index));
  }

  function patchHeader(index: number, patch: Partial<HeaderDraft>): void {
    setHeaders((current) => current.map((header, i) => (i === index ? { ...header, ...patch } : header)));
  }

  function addSlot(): void {
    setSlots([...slots, { id: "", label: "", header: "", format: "{secret}" }]);
  }

  function removeSlot(index: number): void {
    setSlots(slots.filter((_, i) => i !== index));
  }

  function patchSlot(index: number, patch: Partial<SlotDraft>): void {
    setSlots((current) => current.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)));
  }

  function payload(nextEnabled = enabled) {
    const headerMap: Record<string, string> = {};
    for (const header of headers) {
      if (header.name.trim() || header.value.trim()) headerMap[header.name.trim()] = header.value;
    }
    return {
      name: name.trim(),
      label: label.trim(),
      description: description.trim(),
      url: url.trim(),
      transport,
      headers: headerMap,
      secretSlots: slots
        .filter((slot) => slot.header.trim() || slot.label.trim())
        .map((slot) => ({
          ...(slot.id ? { id: slot.id } : {}),
          label: slot.label.trim(),
          header: slot.header.trim(),
          format: slot.format.trim(),
        })),
      enabled: nextEnabled,
    };
  }

  async function save(): Promise<void> {
    if (!formReady) return;
    setFormBusy(true);
    setFormError("");
    // The form is locked while it saves, so what it holds now is what is saved.
    const savedName = name.trim();
    try {
      if (isEdit) {
        await api(`/api/admin/shared-mcp-servers/${encodeURIComponent(editingName!)}`, {
          method: "PUT",
          body: JSON.stringify(payload()),
        });
      } else {
        await api("/api/admin/shared-mcp-servers", { method: "POST", body: JSON.stringify(payload()) });
      }
      notify(`공용 MCP 서버 "${savedName}"을(를) 저장했습니다. 다음 메시지부터 적용됩니다.`, "ok");
      setEditingName(null);
      await load();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setFormBusy(false);
    }
  }

  function serverBody(server: SharedMcpServerView, nextEnabled: boolean) {
    return {
      name: server.name,
      label: server.label,
      description: server.description,
      url: server.url,
      transport: server.transport,
      headers: server.headers,
      secretSlots: server.secretSlots,
      enabled: nextEnabled,
    };
  }

  function markRowBusy(serverName: string, busy: boolean): void {
    setRowBusy((current) => ({ ...current, [serverName]: busy }));
  }

  function noteRow(serverName: string, note: string): void {
    setRowStatus((current) => ({ ...current, [serverName]: note }));
  }

  async function toggleEnabled(server: SharedMcpServerView): Promise<void> {
    if (rowBusy[server.name]) return;
    markRowBusy(server.name, true);
    try {
      await api(`/api/admin/shared-mcp-servers/${encodeURIComponent(server.name)}`, {
        method: "PUT",
        body: JSON.stringify(serverBody(server, !server.enabled)),
      });
      notify(`"${server.label}"을(를) ${server.enabled ? "껐습니다" : "켰습니다"}. 다음 메시지부터 적용됩니다.`, "ok");
      await load();
    } catch (err) {
      notify(`상태 변경 실패: ${(err as Error).message}`);
    } finally {
      markRowBusy(server.name, false);
    }
  }

  async function remove(server: SharedMcpServerView): Promise<void> {
    if (rowBusy[server.name]) return;
    if (!(await confirmAction(`공용 MCP 서버 "${server.label}"을(를) 삭제할까요? 모든 아바타에서 다음 메시지부터 빠집니다.`))) return;
    markRowBusy(server.name, true);
    try {
      await api(`/api/admin/shared-mcp-servers/${encodeURIComponent(server.name)}`, { method: "DELETE" });
      notify(`공용 MCP 서버 "${server.label}"을(를) 삭제했습니다.`, "ok");
      setEditingName((current) => (current === server.name ? null : current));
      await load();
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`);
    } finally {
      markRowBusy(server.name, false);
    }
  }

  async function check(server: SharedMcpServerView): Promise<void> {
    if (rowBusy[server.name]) return;
    markRowBusy(server.name, true);
    noteRow(server.name, "내가 연결한 시크릿으로 접속해 도구 목록을 확인하는 중…");
    try {
      const result = await api<CheckResult>(`/api/admin/shared-mcp-servers/${encodeURIComponent(server.name)}/check`, {
        method: "POST",
      });
      noteRow(
        server.name,
        result.ok
          ? `연결됨 · 도구 ${result.tools.length}개${result.tools.length ? `: ${result.tools.slice(0, 12).join(", ")}${result.tools.length > 12 ? " …" : ""}` : ""}`
          : result.error || "연결 확인 실패",
      );
    } catch (err) {
      noteRow(server.name, `연결 확인 실패: ${(err as Error).message}`);
    } finally {
      markRowBusy(server.name, false);
    }
  }

  if (!active) return null;

  return (
    <div className="admin-users shared-mcp-panel cmp-admin-shared-mcp-panel">
      <section className="settings-card">
        <div className="panel-section-head">
          <div>
            <h3>공용 MCP 서버</h3>
            <p className="muted">
              외부 HTTP MCP 서버를 등록하면 모든 아바타가 그 도구를 씁니다. 사용자별 인증이 필요하면 <strong>인증 자리</strong>(어느 헤더에 어떤 형식으로)만
              정해 두세요. 어떤 시크릿을 넣을지는 각 사용자가 자기 시크릿 카드에서 직접 고릅니다.
            </p>
          </div>
          <div className="ar-actions">
            <button className="ghost-sm" type="button" disabled={loading} onClick={() => void load()}>
              {loading ? "새로고침 중…" : "새로고침"}
            </button>
            <button className="primary small" type="button" disabled={editingName !== null} onClick={openCreate}>
              <Icon name="plus" size={16} /> 추가
            </button>
          </div>
        </div>
        <ul className="hint-list">
          <li>
            관리자는 사용자의 시크릿을 지정하거나 볼 수 없습니다. 사용자가 인증 자리에 자기 시크릿을 연결해야 그 사용자의 본인 대화·팀원 대화에서 서버가 붙고, 일반 동료
            대화에서는 빠집니다.
          </li>
          <li>연결은 서버 주소의 호스트에 묶입니다. 주소의 호스트를 바꾸면 모든 사용자의 연결이 해제되어 다시 연결해야 합니다.</li>
          <li>
            고정 헤더는 모든 사용자의 실행에 그대로 전송됩니다. 외부 통신 차단이 켜져 있다면 서버 도메인이 차단 목록에 없어야 합니다. 변경은 다음 메시지부터 적용됩니다.
          </li>
        </ul>

        {editingName !== null && (
          <form
            className="settings-form shared-mcp-form"
            aria-busy={formBusy}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <h4>{isEdit ? `"${editingName}" 편집` : "새 공용 MCP 서버"}</h4>
            <div className="field-row-2col">
              <label className="field">
                <span>서버 이름</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.currentTarget.value)}
                  disabled={isEdit || formBusy}
                  placeholder="jira"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  aria-describedby={formStatusId}
                />
                <small className="field-hint">
                  도구 이름이 <code>mcp__{name.trim() || "이름"}__도구</code>가 됩니다. 영문 소문자로 시작하고 저장 후에는 바꿀 수 없습니다.
                </small>
              </label>
              <label className="field">
                <span>표시 이름</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.currentTarget.value)}
                  disabled={formBusy}
                  placeholder="사내 Jira"
                  autoComplete="off"
                />
              </label>
            </div>
            <label className="field">
              <span>설명</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
                disabled={formBusy}
                rows={2}
                placeholder="이 서버로 무엇을 할 수 있는지 (아바타와 사용자에게 함께 보입니다)"
              ></textarea>
            </label>
            <div className="field-row-2col">
              <label className="field">
                <span>서버 주소 (URL)</span>
                <input
                  value={url}
                  onChange={(event) => setUrl(event.currentTarget.value)}
                  disabled={formBusy}
                  placeholder="https://mcp.example.com/mcp"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
              <label className="field">
                <span>전송 방식</span>
                <select
                  value={transport}
                  onChange={(event) => setTransport(event.currentTarget.value as SharedMcpTransport)}
                  disabled={formBusy}
                >
                  <option value="http">Streamable HTTP</option>
                  <option value="sse">SSE (레거시)</option>
                </select>
              </label>
            </div>
            {originChanges && (
              <div className="warn-box" role="status">
                호스트가 {savedOrigin}에서 {editedOrigin}(으)로 바뀝니다. 저장하면 모든 사용자의 시크릿 연결이 해제되어 각자 다시 연결해야 합니다.
              </div>
            )}
            <div className="field">
              <span>인증 자리</span>
              {slots.map((slot, index) => (
                <div className="shared-mcp-slot-row" key={index}>
                  <input
                    value={slot.label}
                    onChange={(event) => patchSlot(index, { label: event.currentTarget.value })}
                    disabled={formBusy}
                    placeholder="API 토큰"
                    autoComplete="off"
                    aria-label={`인증 자리 ${index + 1} 이름`}
                  />
                  <input
                    value={slot.header}
                    onChange={(event) => patchSlot(index, { header: event.currentTarget.value })}
                    disabled={formBusy}
                    placeholder="Authorization"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`인증 자리 ${index + 1} 헤더`}
                  />
                  <input
                    value={slot.format}
                    onChange={(event) => patchSlot(index, { format: event.currentTarget.value })}
                    disabled={formBusy}
                    placeholder={"Bearer {secret}"}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`인증 자리 ${index + 1} 형식`}
                  />
                  <button
                    className="ghost-sm"
                    type="button"
                    disabled={formBusy}
                    aria-label={`인증 자리 ${index + 1} 삭제`}
                    onClick={() => removeSlot(index)}
                  >
                    삭제
                  </button>
                </div>
              ))}
              <div>
                <button className="ghost-sm" type="button" disabled={formBusy} onClick={addSlot}>
                  <Icon name="plus" size={14} /> 인증 자리 추가
                </button>
              </div>
              <small className="field-hint">
                형식의 <code>{"{secret}"}</code> 자리에 사용자가 고른 시크릿 값이 들어갑니다. 인증 자리가 없으면 모든 대화에서 같은 설정으로 연결됩니다.
              </small>
            </div>
            <div className="field">
              <span>고정 헤더</span>
              {headers.map((header, index) => (
                <div className="shared-mcp-header-row" key={index}>
                  <input
                    value={header.name}
                    onChange={(event) => patchHeader(index, { name: event.currentTarget.value })}
                    disabled={formBusy}
                    placeholder="X-Team"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`고정 헤더 ${index + 1} 이름`}
                  />
                  <RevealableInput
                    value={header.value}
                    onValueChange={(value) => patchHeader(index, { value })}
                    disabled={formBusy}
                    placeholder="값"
                    ariaLabel={`고정 헤더 ${index + 1} 값`}
                  />
                  <button
                    className="ghost-sm"
                    type="button"
                    disabled={formBusy}
                    aria-label={`고정 헤더 ${index + 1} 삭제`}
                    onClick={() => removeHeader(index)}
                  >
                    삭제
                  </button>
                </div>
              ))}
              <div>
                <button className="ghost-sm" type="button" disabled={formBusy} onClick={addHeader}>
                  <Icon name="plus" size={14} /> 고정 헤더 추가
                </button>
              </div>
              <small className="field-hint">모든 사용자에게 같은 값입니다. 사용자별 값은 인증 자리로 받으세요.</small>
            </div>
            <label className="shared-mcp-enabled">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} disabled={formBusy} /> 사용
            </label>
            <div className="settings-save-row">
              <span
                id={formStatusId}
                className={cx("settings-save-status", formBusy && "pending", Boolean(formError || duplicateHeader) && "invalid")}
                role="status"
                aria-live="polite"
              >
                {formBusy
                  ? "저장 중…"
                  : formError
                    ? `저장 실패: ${formError}`
                    : duplicateHeader
                      ? `${duplicateHeader} 헤더가 두 번 들어 있습니다.`
                      : "저장하면 다음 메시지부터 모든 아바타에 적용됩니다."}
              </span>
              <button className="btn" type="button" disabled={formBusy} onClick={closeForm}>
                취소
              </button>
              <button className="primary" type="submit" disabled={!formReady}>
                {formBusy ? "저장 중…" : "저장"}
              </button>
            </div>
          </form>
        )}

        {error ? (
          <div className="warn-box" role="alert">
            공용 MCP 서버 목록을 불러오지 못했습니다: {error}{" "}
            <button className="linkish" type="button" disabled={loading} onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        ) : loading && !initialized ? (
          <div className="muted pad" role="status">
            공용 MCP 서버 목록을 불러오는 중…
          </div>
        ) : !servers.length ? (
          editingName === null && (
            <div className="empty-note">
              <strong>등록된 공용 MCP 서버가 없습니다.</strong>{" "}
              <span className="muted">사내 HTTP MCP 서버 주소와 인증 헤더를 등록해 모든 아바타에 도구를 붙이세요.</span>
            </div>
          )
        ) : (
          <>
            <div className="admin-list" aria-busy={loading}>
              {servers.map((server) => (
                <article className={cx("admin-user", !server.enabled && "is-disabled")} key={server.name}>
                  <div className="admin-row">
                    <div className="ar-main">
                      <strong>{server.label}</strong>
                      <div className="muted mono">mcp__{server.name}__*</div>
                      <div className="muted shared-mcp-url">{server.url}</div>
                      {server.description && <div className="muted">{server.description}</div>}
                    </div>
                    <div className="ar-tags">
                      <span className={`tag ${server.enabled ? "read" : "danger"}`}>{server.enabled ? "사용" : "꺼짐"}</span>
                      <span className="tag mono">{server.transport === "sse" ? "SSE" : "HTTP"}</span>
                      {server.secretSlots.length ? (
                        server.secretSlots.map((slot, index) => (
                          <span className="tag write" title={`${slot.header}: ${slot.format}`} key={index}>
                            인증 자리 · {slot.label}
                          </span>
                        ))
                      ) : (
                        <span className="tag">사용자 시크릿 불필요</span>
                      )}
                    </div>
                    <div className="ar-actions">
                      <button className="ghost-sm" type="button" disabled={rowBusy[server.name]} onClick={() => void check(server)}>
                        {rowBusy[server.name] ? "확인 중…" : "연결 확인"}
                      </button>
                      <button
                        className="ghost-sm"
                        type="button"
                        disabled={rowBusy[server.name] || editingName !== null}
                        onClick={() => openEdit(server)}
                      >
                        편집
                      </button>
                      <button className="ghost-sm" type="button" disabled={rowBusy[server.name]} onClick={() => void toggleEnabled(server)}>
                        {server.enabled ? "끄기" : "켜기"}
                      </button>
                      <button className="ghost-sm danger" type="button" disabled={rowBusy[server.name]} onClick={() => void remove(server)}>
                        삭제
                      </button>
                    </div>
                  </div>
                  {rowStatus[server.name] && (
                    <div className="muted shared-mcp-row-note" role="status" aria-live="polite">
                      {rowStatus[server.name]}
                    </div>
                  )}
                </article>
              ))}
            </div>
            <p className="muted shared-mcp-footnote">연결 확인은 지금 로그인한 관리자 본인이 시크릿 카드에서 연결한 시크릿으로 접속합니다.</p>
          </>
        )}
      </section>
    </div>
  );
}
