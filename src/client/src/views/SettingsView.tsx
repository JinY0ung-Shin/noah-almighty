import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Icon from "../components/Icon";
import SettingsProfileTab from "../components/SettingsProfileTab";
import SettingsAccessTab from "../components/SettingsAccessTab";
import SettingsKnowledgeTab from "../components/SettingsKnowledgeTab";
import { cx, useAppState } from "../lib/hooks";
import { loadSettingsData } from "../lib/loaders";
import { updateState } from "../lib/state";

const tabs = [
  { id: "profile", label: "프로필", icon: "user" },
  { id: "access", label: "권한·연결", icon: "shield" },
  { id: "knowledge", label: "지식·플러그인", icon: "book" },
] as const;
type SettingsTabId = (typeof tabs)[number]["id"];

export default function SettingsView() {
  const state = useAppState();
  const [loading, setLoading] = useState(true);
  const [loadBusy, setLoadBusyState] = useState(false);
  // The retry button shows `loadBusy`; the guard reads the value last set.
  const loadBusyRef = useRef(false);
  const [error, setError] = useState("");

  const user = state.user;
  const settingsTab = state.settingsTab;

  function setLoadBusy(next: boolean): void {
    loadBusyRef.current = next;
    setLoadBusyState(next);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(): Promise<void> {
    if (loadBusyRef.current) return;
    setLoadBusy(true);
    setLoading(true);
    setError("");
    try {
      await loadSettingsData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setLoadBusy(false);
    }
  }

  function setSettingsTab(id: SettingsTabId): void {
    updateState((state) => (state.settingsTab = id));
  }

  function focusSettingsTab(id: SettingsTabId): void {
    requestAnimationFrame(() => document.getElementById(`settings-tab-${id}`)?.focus());
  }

  function onSettingsTabKeydown(event: KeyboardEvent<HTMLButtonElement>, currentId: SettingsTabId): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabs.findIndex((tab) => tab.id === currentId);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex].id;
    setSettingsTab(next);
    focusSettingsTab(next);
  }

  return (
    <>
      <header className="view-header">
        <div className="title">
          <h1>내 아바타</h1>
          <p>프로필·권한·지식을 관리하세요</p>
        </div>
      </header>

      <div className={cx("view-body scroll-thin settings-body", settingsTab === "access" && "settings-body-access")}>
        {loading ? (
          <div className="muted pad" role="status">
            불러오는 중…
          </div>
        ) : error ? (
          <div className="warn-box" role="alert">
            설정 정보를 불러오지 못했습니다: {error}{" "}
            <button className="linkish" type="button" disabled={loadBusy} onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        ) : user ? (
          <>
            <div className="settings-tabs settings-primary-tabs" role="tablist" aria-label="설정 분류">
              {tabs.map((tab, index) => (
                <button
                  key={index}
                  id={`settings-tab-${tab.id}`}
                  className={cx("settings-tab", settingsTab === tab.id && "active")}
                  type="button"
                  role="tab"
                  aria-selected={settingsTab === tab.id}
                  aria-controls="settings-panel"
                  tabIndex={settingsTab === tab.id ? 0 : -1}
                  onClick={() => setSettingsTab(tab.id)}
                  onKeyDown={(event) => onSettingsTabKeydown(event, tab.id)}
                >
                  <Icon name={tab.icon} />
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            {/* The tabs stay ALWAYS MOUNTED and only get `active`: unmounting one
                would lose its unsaved form text (docs/architecture/client.md). */}
            <div
              id="settings-panel"
              className={cx("settings-panel", settingsTab === "access" && "settings-panel-access")}
              role="tabpanel"
              aria-labelledby={`settings-tab-${settingsTab}`}
            >
              <SettingsProfileTab active={settingsTab === "profile"} />
              <SettingsAccessTab active={settingsTab === "access"} />
              <SettingsKnowledgeTab active={settingsTab === "knowledge"} />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
