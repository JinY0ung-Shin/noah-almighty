// 관리자 ▸ 도구·스킬 ▸ MCP 도구 정책 — ONE deployment-wide allowlist of MCP
// tool groups (GET/PUT /api/admin/tool-policy). Replaced the per-group policy
// editor when groups were retired (single team, 2026-11-06). Always mounted by
// AdminView with an `active` prop so an unsaved draft survives tab switches.
import { useLayoutEffect, useRef, useState } from "react";
import { api, refreshMe } from "../lib/api";
import { cx } from "../lib/hooks";
import { notify } from "../lib/state";
import { MCP_TOOL_GROUPS, effectiveMcpToolGroups, isRequiredMcpToolGroup, type McpToolGroupId } from "../../../shared/mcpToolGroups";

export interface AdminToolPolicyPanelProps {
  active?: boolean;
}

const statusId = "admin-tool-policy-status";

// `undefined` until the first successful load; `null` = no restriction.
type Saved = McpToolGroupId[] | null | undefined;

function isDirty(saved: Saved, restricted: boolean, draft: Set<McpToolGroupId>): boolean {
  if (saved === undefined) return false;
  const savedEffective = saved === null ? null : effectiveMcpToolGroups(saved);
  return (
    restricted !== (savedEffective !== null) ||
    (restricted &&
      savedEffective !== null &&
      (draft.size !== savedEffective.length || savedEffective.some((id) => !draft.has(id))))
  );
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

export default function AdminToolPolicyPanel({ active = false }: AdminToolPolicyPanelProps) {
  const initialized = useRef(false);
  const [loading, setLoading, loadingRef] = useLive(false);
  const [loadError, setLoadError] = useState("");
  const [saved, setSaved, savedRef] = useLive<Saved>(undefined);
  // `restricted` off ⇒ null(제한 없음); on ⇒ the checked allowlist (may be []).
  const [restricted, setRestricted, restrictedRef] = useLive(false);
  const [draft, setDraft, draftRef] = useLive(new Set<McpToolGroupId>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loaded = saved !== undefined;
  const dirty = isDirty(saved, restricted, draft);
  const status = busy
    ? "저장 중…"
    : error
      ? `저장 실패: ${error}`
      : restricted && [...draft].every(isRequiredMcpToolGroup)
        ? "선택 가능한 도구 묶음이 모두 차단됩니다. 시스템 도구는 항상 사용할 수 있습니다."
        : dirty
          ? "저장하지 않은 도구 정책 변경 사항이 있습니다."
          : restricted
            ? `허용 ${draft.size}/${MCP_TOOL_GROUPS.length} — 저장됨`
            : "제한 없음 — 모든 팀원이 모든 MCP 도구 묶음을 쓸 수 있습니다.";

  function seed(value: McpToolGroupId[] | null): void {
    setSaved(value);
    setRestricted(value !== null);
    setDraft(new Set<McpToolGroupId>(effectiveMcpToolGroups(value)));
    setError("");
  }

  async function load(): Promise<void> {
    initialized.current = true;
    if (loadingRef.current) return;
    setLoading(true);
    setLoadError("");
    try {
      const { allowedMcpToolGroups } = await api<{ allowedMcpToolGroups: McpToolGroupId[] | null }>("/api/admin/tool-policy");
      // A manual 다시 불러오기 never discards an unsaved draft.
      if (!isDirty(savedRef.current, restrictedRef.current, draftRef.current)) seed(allowedMcpToolGroups);
      else setSaved(allowedMcpToolGroups);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // A layout effect, so the first paint of the tab already says it is loading.
  useLayoutEffect(() => {
    if (active && !initialized.current) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function toggle(id: McpToolGroupId, on: boolean): void {
    if (busy || isRequiredMcpToolGroup(id)) return;
    const next = new Set(draft);
    if (on) next.add(id);
    else next.delete(id);
    setDraft(next);
    setError("");
  }

  async function save(): Promise<void> {
    if (busy || !dirty) return;
    setBusy(true);
    setError("");
    const allowed = restricted ? MCP_TOOL_GROUPS.map((g) => g.id).filter((id) => draft.has(id)) : null;
    try {
      const result = await api<{ allowedMcpToolGroups: McpToolGroupId[] | null }>("/api/admin/tool-policy", {
        method: "PUT",
        body: JSON.stringify({ allowedMcpToolGroups: allowed }),
      });
      seed(result.allowedMcpToolGroups);
      notify(
        result.allowedMcpToolGroups === null
          ? "MCP 도구 제한을 해제했습니다."
          : `MCP 도구 정책을 저장했습니다. (허용 ${result.allowedMcpToolGroups.length}/${MCP_TOOL_GROUPS.length})`,
        "ok",
      );
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      notify(`도구 정책 저장 실패: ${message}`);
      return;
    } finally {
      setBusy(false);
    }
    // The admin's own composer reads the policy from /api/me — refresh it so
    // the picker reflects the change without a reload. Best-effort.
    try {
      await refreshMe();
    } catch {
      /* the next /api/me picks it up */
    }
  }

  if (!active) return null;

  return (
    <section className="settings-card" aria-labelledby="admin-tool-policy-heading">
      <div className="panel-section-head">
        <div>
          <h3 id="admin-tool-policy-heading">MCP 도구 정책</h3>
          <p className="muted">
            모든 팀원이 아바타 대화에서 사용할 수 있는 MCP 도구 묶음을 제한합니다. 허용하지 않은 묶음은 대화 도구 선택에서
            꺼진 채 표시되고, 서버가 모든 실행에서 다시 막습니다. 시스템 도구는 항상 사용하며 개별 작업의 권한 검사는 유지됩니다.
          </p>
        </div>
        <button className="ghost-sm" type="button" disabled={loading || busy} onClick={() => void load()}>
          {loading ? "불러오는 중…" : "다시 불러오기"}
        </button>
      </div>
      {!loaded && loading ? (
        <div className="muted" role="status">
          불러오는 중…
        </div>
      ) : !loaded && loadError ? (
        <div className="warn-box" role="alert">
          도구 정책을 불러오지 못했습니다: {loadError}{" "}
          <button className="linkish" type="button" disabled={loading} onClick={() => void load()}>
            다시 시도
          </button>
        </div>
      ) : loaded ? (
        <>
          {loadError && (
            <div className="warn-box" role="alert">
              최신 정책을 불러오지 못했습니다: {loadError}
            </div>
          )}
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="policy-option">
              <input
                type="checkbox"
                checked={restricted}
                aria-describedby={statusId}
                disabled={busy}
                onChange={(event) => {
                  setRestricted(event.currentTarget.checked);
                  setError("");
                }}
              />
              <span>
                <strong>MCP 도구 묶음 제한 사용</strong>
                <small className="muted">끄면 모든 팀원이 모든 MCP 도구 묶음을 쓸 수 있습니다.</small>
              </span>
            </label>
            {restricted && (
              <div className="policy-option-picker" role="group" aria-label="허용할 MCP 도구 묶음" aria-describedby={statusId}>
                {MCP_TOOL_GROUPS.map((toolGroup) => (
                  <label className="policy-option" key={toolGroup.id}>
                    <input
                      type="checkbox"
                      checked={draft.has(toolGroup.id)}
                      aria-describedby={statusId}
                      disabled={busy || isRequiredMcpToolGroup(toolGroup.id)}
                      onChange={(event) => toggle(toolGroup.id, event.currentTarget.checked)}
                    />
                    <span>
                      <strong>
                        {toolGroup.labelKo}
                        {isRequiredMcpToolGroup(toolGroup.id) ? " · 항상 사용" : ""}
                      </strong>{" "}
                      <small className="muted">{toolGroup.descriptionKo}</small>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="settings-save-row">
              <span
                id={statusId}
                className={cx("settings-save-status", Boolean(dirty && !busy && !error) && "dirty", busy && "pending", Boolean(error) && "invalid")}
                role="status"
                aria-live="polite"
              >
                {status}
              </span>
              <button className="primary" type="submit" disabled={busy || !dirty}>
                {busy ? "저장 중…" : "정책 저장"}
              </button>
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
