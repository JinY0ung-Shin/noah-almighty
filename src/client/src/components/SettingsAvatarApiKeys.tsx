import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import type { AvatarApiKey } from "../../../shared/avatarTasks";
import { api } from "../lib/api";
import { copyText } from "../lib/dom";
import { useLatest } from "../lib/hooks";
import { notify } from "../lib/state";
import "./SettingsAvatarApiKeys.css";

export interface SettingsAvatarApiKeysProps {
  active?: boolean;
}

export default function SettingsAvatarApiKeys({ active = false }: SettingsAvatarApiKeysProps) {
  const [keys, setKeys] = useState<AvatarApiKey[]>([]);
  const [loaded, setLoadedState] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const newKeyId = useRef("");
  // `busy`/`loaded` are shown AND read by code that runs later (after an await,
  // from an effect), so each has a ref that always holds the value last set.
  const loadedRef = useRef(false);
  const busyRef = useRef(false);
  const activeRef = useLatest(active);

  function setLoaded(next: boolean): void {
    loadedRef.current = next;
    setLoadedState(next);
  }
  function setBusy(next: boolean): void {
    busyRef.current = next;
    setBusyState(next);
  }

  // Layout effects, so the list never paints in a state the load is about to
  // replace (the first frame of the tab already says 불러오는 중…).
  useLayoutEffect(() => {
    if (active && !loadedRef.current && !busyRef.current) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loaded, busy]);
  // Leaving the tab drops both the one-time secret and the cached list, so a
  // re-entry (or a different account after a re-login) always refetches.
  useLayoutEffect(() => {
    if (!active) {
      setToken("");
      setLoaded(false);
    }
  }, [active]);

  async function load() {
    setBusy(true);
    setLoaded(true);
    setError("");
    try {
      const next = (await api<{ keys: AvatarApiKey[] }>("/api/me/avatar-api-keys")).keys;
      setKeys(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    if (busyRef.current || !name.trim()) return;
    setBusy(true);
    setError("");
    setToken("");
    try {
      const result = await api<{ key: AvatarApiKey; token: string }>("/api/me/avatar-api-keys", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      });
      setKeys((prev) => [result.key, ...prev]);
      newKeyId.current = result.key.id;
      setToken(activeRef.current ? result.token : "");
      setName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    if (busyRef.current) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/me/avatar-api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      setKeys((prev) => prev.filter((key) => key.id !== id));
      if (id === newKeyId.current) setToken("");
      notify("API 키를 폐기했습니다.", "ok");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // copyText never throws: it reports the outcome by flashing the button it is
  // given, and stays SILENT without one. So pass the button — otherwise a failed
  // write (non-secure context, denied permission) would look exactly like a
  // success and the owner could close the one-time reveal with nothing copied.
  function copyToken(event: MouseEvent<HTMLButtonElement>): void {
    void copyText(token, event.currentTarget);
  }

  if (!active) return null;

  return (
    <section className="settings-card cmp-settings-avatar-api-keys">
      <div className="panel-section-head">
        <div>
          <h3>외부 작업 API</h3>
          <p className="muted">
            외부 시스템에서 내 아바타에게 자유롭게 지시할 수 있습니다. 이 키로 내 아바타의 도구를 사용하고 작업 결과를 조회할 수 있습니다.
            이 키는 <strong>로그인한 나와 똑같은 권한</strong>으로 동작해 내 채팅의 모든 도구, 셸에 노출된 비밀값, 저장소 커밋까지 쓸 수 있으니 비밀번호처럼 보관하세요.
          </p>
        </div>
      </div>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label className="field">
          <span>API 키 이름</span>
          <input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={80}
            placeholder="예: 장애 모니터링"
            required
            disabled={busy}
          />
        </label>
        <button className="primary" type="submit" disabled={busy || !name.trim() || keys.length >= 10}>
          {busy ? "처리 중…" : "API 키 발급"}
        </button>
      </form>
      {token ? (
        <div className="key-reveal">
          <label className="field">
            <span>발급된 키 — 지금 한 번만 표시됩니다</span>
            <input readOnly value={token} aria-label="발급된 API 키" autoComplete="off" spellCheck={false} />
          </label>{" "}
          <button type="button" className="btn" onClick={copyToken}>
            키 복사
          </button>{" "}
          <button type="button" className="linkish" onClick={() => setToken("")}>
            닫기
          </button>{" "}
          <p className="muted">복사가 되지 않으면 위 입력란의 키를 직접 선택해 복사하세요.</p>
        </div>
      ) : null}
      {error ? (
        <div className="warn-box" role="alert">
          {error}{" "}
          <button className="linkish" type="button" disabled={busy} onClick={() => void load()}>
            목록 다시 불러오기
          </button>
        </div>
      ) : null}
      <div className="secret-list">
        {/* A reply without the list leaves `keys` undefined; the list then reads as empty, as it always has. */}
        {keys?.length ? (
          keys.map((key) => (
            <div className="secret-row" key={key.id}>
              <strong>{key.name}</strong>
              <code>{key.prefix}…</code>
              <span className="muted">
                {key.lastUsedAt ? `최근 사용: ${new Date(key.lastUsedAt).toLocaleString("ko-KR")}` : "사용 이력 없음"}
              </span>
              <button
                className="linkish small"
                type="button"
                disabled={busy}
                aria-label={`API 키 폐기: ${key.name}`}
                onClick={() => void revoke(key.id)}
              >
                폐기
              </button>
            </div>
          ))
        ) : (
          <p className="muted">{busy ? "불러오는 중…" : "발급된 API 키가 없습니다."}</p>
        )}
      </div>
      <details>
        <summary>호출 방법</summary>
        <p className="muted">아래 경로로 JSON을 전송하세요. 조건과 지시 내용은 외부 시스템에서 정합니다.</p>
        <pre>
          {"POST /api/v1/avatar/tasks\nAuthorization: Bearer <발급된 API 키>\nContent-Type: application/json\n\n"}
          {JSON.stringify({ message: "서비스 A의 오류 로그를 확인하고 원인을 분석해 줘" }, null, 2)}
        </pre>
        <p className="muted">접수 응답의 task.id로 GET /api/v1/avatar/tasks/:id를 호출하면 상태와 결과를 확인할 수 있습니다. conversationId를 함께 보내면 기존 내 아바타 대화에 이어집니다. 결과와 추가 질문은 Noah의 해당 대화에서도 확인하세요.</p>
        <p className="muted">키 폐기 시 새 요청과 대기 중인 작업이 차단됩니다. 이미 실행 중인 작업은 대화에서 중지할 수 있습니다.</p>
      </details>
    </section>
  );
}
