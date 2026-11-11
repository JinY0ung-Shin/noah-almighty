// Shared plugin-selection contents (per-plugin checkboxes). Ports
// renderPluginSelectionContents from settings/plugins.js. Used by plugin,
// personal knowledge repo, and group knowledge repo selectors — identical
// DOM/behavior, differing only in selection source + save destination.
import { useState } from "react";
import { cx } from "../lib/hooks";
import { notify } from "../lib/state";
import type { RepoPluginContents } from "../lib/types";

let nextPluginSelectId = 0;

export interface SettingsPluginSelectProps {
  info: RepoPluginContents;
  /** Current selection: array of names, or null = "load all". */
  selected: string[] | null;
  headText: string;
  /** Persist the chosen selection (null = load all). Should reject on failure. */
  onSave: (selected: string[] | null) => Promise<void>;
}

function selectionKey(value: string[] | null): string {
  return value ? [...value].sort().join("\u001f") : "__all__";
}

function checksFromSelection(info: RepoPluginContents, value: string[] | null): Record<string, boolean> {
  const source = value ? new Set(value) : null;
  const next: Record<string, boolean> = {};
  for (const entry of info.plugins) {
    next[entry.name] = entry.loadable && (!source || source.has(entry.name));
  }
  return next;
}

export default function SettingsPluginSelect({ info, selected, headText, onSave }: SettingsPluginSelectProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [pluginSelectId] = useState(() => `plugin-select-${++nextPluginSelectId}`);

  const loadableNames = info.kind === "marketplace" ? info.plugins.filter((p) => p.loadable).map((p) => p.name) : [];
  const selectedKey = selectionKey(selected);
  const infoKey = `${info.kind}:${info.plugins.map((p) => `${p.name}:${p.loadable ? "1" : "0"}`).join("|")}`;

  // Per-row checked state, seeded from the current selection (null = all on).
  const seedKey = `${infoKey}:${selectedKey}`;
  const [checks, setChecks] = useState<Record<string, boolean>>(() => checksFromSelection(info, selected));
  const [seededFor, setSeededFor] = useState(seedKey);
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    setChecks(checksFromSelection(info, selected));
    setError("");
  }

  function normalizedSelection(): string[] | null {
    const chosen = info.plugins.filter((e) => e.loadable && checks[e.name]).map((e) => e.name);
    // All (or none) selected -> null = "load all".
    return chosen.length === 0 || chosen.length === loadableNames.length ? null : chosen;
  }

  const chosenCount = info.plugins.filter((e) => e.loadable && checks[e.name]).length;
  const nextSelection = normalizedSelection();
  const dirty = selectionKey(nextSelection) !== selectedKey;
  const allLoadableChecked = Boolean(loadableNames.length) && chosenCount === loadableNames.length;
  const canSave = Boolean(loadableNames.length && dirty && !saving);
  const summary = !loadableNames.length
    ? "로드 가능한 플러그인이 없습니다."
    : chosenCount === 0
      ? `선택된 항목이 없습니다. 저장하면 로드 가능한 ${loadableNames.length}개 전체가 사용됩니다.`
      : chosenCount === loadableNames.length
        ? `로드 가능한 ${loadableNames.length}개 전체가 사용됩니다.`
        : `${chosenCount}개만 사용하도록 저장됩니다.`;
  const saveStatus = saving
    ? "저장 중입니다."
    : error
      ? `저장 실패: ${error}`
      : saved && !dirty
        ? "저장되었습니다."
        : dirty
          ? "저장하지 않은 선택 변경이 있습니다."
          : "저장된 선택과 같습니다.";
  const saveLabel = saving ? "저장 중…" : saved && !dirty ? "저장됨 ✓" : dirty ? "선택 저장" : "변경 없음";

  function useAll(): void {
    const next = { ...checks };
    for (const name of loadableNames) next[name] = true;
    setChecks(next);
    setSaved(false);
    setError("");
  }

  function restoreSelection(): void {
    setChecks(checksFromSelection(info, selected));
    setSaved(false);
    setError("");
  }

  async function save(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      await onSave(nextSelection);
      notify("플러그인 선택을 저장했습니다.", "ok");
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      notify(`저장 실패: ${message}`, "warn");
    } finally {
      setSaving(false);
    }
  }

  if (info.kind === "none") {
    return (
      <div className="error-note" role="alert">
        Claude 플러그인 저장소가 아닙니다 (plugin.json / marketplace.json 없음).
      </div>
    );
  }
  if (info.kind === "single") {
    return <div className="muted">단일 플러그인 저장소입니다 — 선택할 항목이 없습니다.</div>;
  }
  if (!info.plugins.length) {
    return <div className="muted">불러올 수 있는 플러그인이 없습니다.</div>;
  }
  return (
    <>
      <div className="pc-head-row">
        <div className="pc-head muted" id={`${pluginSelectId}-head`}>
          {headText}
        </div>
        {loadableNames.length ? (
          <div className="pc-toolbar" role="group" aria-label="플러그인 선택 빠른 작업">
            <button className="linkish small" type="button" disabled={saving || allLoadableChecked} onClick={useAll}>
              전체 사용
            </button>
            <button className="linkish small" type="button" disabled={saving || !dirty} onClick={restoreSelection}>
              저장값 복원
            </button>
          </div>
        ) : null}
      </div>
      <div className="pc-list" role="group" aria-labelledby={`${pluginSelectId}-head`} aria-describedby={`${pluginSelectId}-summary`}>
        {info.plugins.map((entry) => (
          <label key={entry.name} className={`pc-item ${entry.loadable ? "" : "disabled"}`}>
            <input
              type="checkbox"
              checked={Boolean(checks[entry.name])}
              disabled={!entry.loadable || saving}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setChecks((prev) => ({ ...prev, [entry.name]: checked }));
              }}
            />
            <span>{entry.loadable ? entry.name : `${entry.name} (로드 불가)`}</span>
          </label>
        ))}
      </div>
      <div className="pc-summary muted" id={`${pluginSelectId}-summary`} role="status" aria-live="polite">
        {summary}
      </div>
      {loadableNames.length ? (
        <div className="pc-actions">
          <span
            className={cx(
              "pc-save-status",
              dirty && !saving && !error && "dirty",
              saving && "pending",
              saved && !dirty && "success",
              Boolean(error) && "invalid",
            )}
            role="status"
            aria-live="polite"
          >
            {saveStatus}
          </span>
          <button className="primary small" type="button" disabled={!canSave} onClick={() => void save()}>
            {saveLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}
