import { Fragment, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";
import Toggle from "./Toggle";
import SettingsPluginSelect from "./SettingsPluginSelect";
import GraphViewModal from "./GraphViewModal";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { openSeededChat } from "../lib/chat";
import { cx, useAppState } from "../lib/hooks";
import { Presence } from "../lib/presence";
import { notify, readState, replaceState, updateState } from "../lib/state";
import { repoToHref, timeLabel } from "../lib/format";
import type { Plugin, RepoPluginContents, User } from "../lib/types";

export interface SettingsKnowledgeTabProps {
  active?: boolean;
}

const krContentsId = "knowledge-repo-plugin-contents";
const knowledgeStatusId = "knowledge-repo-save-status";
const pluginAddStatusId = "plugin-add-save-status";

function summarizeRepoContentsError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("repository not found")) return "저장소를 찾지 못했습니다. 저장소 주소 또는 접근 권한을 확인해 주세요.";
  if (lower.includes("command failed") || lower.includes("git clone")) return "저장소 내용을 가져오지 못했습니다.";
  return message.length > 140 ? `${message.slice(0, 140)}…` : message;
}

function shouldShowRepoErrorDetails(message: string): boolean {
  return message.length > 140 || /command failed|git clone/i.test(message);
}

function pluginContentsPanelId(id: string): string {
  return `plugin-contents-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function refEditPanelId(id: string): string {
  return `plugin-ref-edit-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function isKnowledgeDirty(user: User | null, repoTrimmed: string, branchTrimmed: string): boolean {
  return Boolean(user && (repoTrimmed !== (user.knowledgeRepo || "") || (branchTrimmed || "") !== (user.knowledgeBranch || "")));
}

function pluginSyncLabel(p: Plugin): string {
  if (!p.lastSyncedAt) return "아직 동기화되지 않음";
  const label = timeLabel(p.lastSyncedAt);
  return label ? `동기화: ${label}` : "";
}

function pluginSelSummary(p: Plugin): string {
  return !p.selected ? "모든 플러그인 사용" : `${p.selected.length}개 선택됨`;
}

/**
 * A value the markup shows AND a function reads later — after an `await`, or
 * from a handler that can run before the next render. The state is what
 * renders; the ref is written with it, so such a function always reads the
 * current value, as it did when this was one plain variable.
 */
function useLiveState<T>(initial: T): [T, (next: T) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useRef((next: T): void => {
    ref.current = next;
    setValue(next);
  });
  return [value, set.current, ref];
}

/**
 * `await tick()`: resolves once the state set so far is in the DOM (the update
 * this schedules is rendered together with the ones already pending, and the
 * promise resolves from the layout effect of that commit).
 */
function useTick(): () => Promise<void> {
  const [committed, setRequested] = useState(0);
  const requested = useRef(0);
  const waiting = useRef<Array<{ at: number; resolve: () => void }>>([]);
  useLayoutEffect(() => {
    if (!waiting.current.length) return;
    const due = waiting.current.filter((entry) => entry.at <= committed);
    waiting.current = waiting.current.filter((entry) => entry.at > committed);
    for (const entry of due) entry.resolve();
  }, [committed]);
  const tick = useRef(
    (): Promise<void> =>
      new Promise<void>((resolve) => {
        requested.current += 1;
        waiting.current.push({ at: requested.current, resolve });
        setRequested(requested.current);
      }),
  );
  return tick.current;
}

export default function SettingsKnowledgeTab({ active = false }: SettingsKnowledgeTabProps) {
  const state = useAppState();
  const tick = useTick();

  // Form state is initialised ONCE (the tab is always mounted — see SettingsView).
  const [u0] = useState(() => readState().user);

  // knowledge repo form
  const [knowledgeRepo, setKnowledgeRepo, knowledgeRepoRef] = useLiveState(u0?.knowledgeRepo || "");
  const [knowledgeBranch, setKnowledgeBranch, knowledgeBranchRef] = useLiveState(u0?.knowledgeBranch || "");
  const [krBusy, setKrBusy, krBusyRef] = useLiveState(false);
  const [krRefreshed, setKrRefreshed] = useState(false);
  const [krPickOpen, setKrPickOpen, krPickOpenRef] = useLiveState(false);
  const [krContents, setKrContents, krContentsRef] = useLiveState<RepoPluginContents | null>(null);
  const [krContentsErr, setKrContentsErr] = useState("");
  const [krContentsLoading, setKrContentsLoading, krContentsLoadingRef] = useLiveState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [requestRepoBusy, setRequestRepoBusy, requestRepoBusyRef] = useLiveState(false);
  const [knowledgeError, setKnowledgeError] = useState("");
  const [syncedKnowledgeUserId, setSyncedKnowledgeUserId] = useState(u0?.id || "");

  // plugin add form
  const [pluginRepo, setPluginRepo, pluginRepoRef] = useLiveState("");
  const [pluginRef, setPluginRef, pluginRefRef] = useLiveState("");
  const [pluginLabel, setPluginLabel, pluginLabelRef] = useLiveState("");
  const [pluginAddBusy, setPluginAddBusy, pluginAddBusyRef] = useLiveState(false);
  const [pluginAddError, setPluginAddError] = useState("");
  // per-plugin expandable contents
  const [openPluginId, setOpenPluginId, openPluginIdRef] = useLiveState("");
  const [pluginContents, setPluginContents, pluginContentsRef] = useLiveState<Record<string, RepoPluginContents>>({});
  const [pluginContentsErr, setPluginContentsErr, pluginContentsErrRef] = useLiveState<Record<string, string>>({});
  const [pluginContentsLoading, setPluginContentsLoading, pluginContentsLoadingRef] = useLiveState<Record<string, boolean>>({});
  const [pluginRowBusy, setPluginRowBusy, pluginRowBusyRef] = useLiveState<Record<string, boolean>>({});
  // per-plugin ref (branch/tag) editor
  const [refEditId, setRefEditId, refEditIdRef] = useLiveState("");
  const [refDraft, setRefDraft, refDraftRef] = useLiveState("");
  const [refSaveBusy, setRefSaveBusy, refSaveBusyRef] = useLiveState(false);
  const [refSaveError, setRefSaveError] = useState("");

  const user = state.user;
  const githubHost = state.bootstrap?.githubHost || "github.com";
  const plugins = state.plugins;
  const savedKnowledgeRepo = user?.knowledgeRepo || "";
  const knowledgeRepoTrimmed = knowledgeRepo.trim();
  const knowledgeBranchTrimmed = knowledgeBranch.trim();
  const knowledgeDirty = isKnowledgeDirty(user, knowledgeRepoTrimmed, knowledgeBranchTrimmed);
  const knowledgeCanSave = Boolean(!krBusy && knowledgeRepoTrimmed && knowledgeDirty);
  const knowledgeStatus = krBusy
    ? "저장 중…"
    : knowledgeError
      ? `저장 실패: ${knowledgeError}`
      : !knowledgeRepoTrimmed && savedKnowledgeRepo
        ? "연결 해제는 오른쪽의 ‘연결 해제’ 버튼을 사용합니다."
        : knowledgeDirty
          ? "저장하지 않은 저장소 변경 사항이 있습니다."
          : savedKnowledgeRepo
            ? "연결됨"
            : "연결 전";
  // Another account took over the session: load ITS repo into the form, once
  // nothing of the previous one is still in flight.
  if (user?.id && user.id !== syncedKnowledgeUserId && !krBusy) {
    syncKnowledgeForm(user);
    setKrPickOpen(false);
    setKrContents(null);
    setKrContentsErr("");
  }
  const pluginRepoTrimmed = pluginRepo.trim();
  const pluginCanAdd = Boolean(!pluginAddBusy && pluginRepoTrimmed);
  const pluginAddStatus = pluginAddBusy
    ? "플러그인을 추가하는 중입니다."
    : pluginAddError
      ? `추가 실패: ${pluginAddError}`
      : pluginRepoTrimmed
        ? "플러그인을 추가할 준비가 됐습니다."
        : "추가할 플러그인 저장소를 입력하세요.";

  // ---- knowledge repo ----
  function syncKnowledgeForm(next: User): void {
    setKnowledgeRepo(next.knowledgeRepo || "");
    setKnowledgeBranch(next.knowledgeBranch || "");
    setSyncedKnowledgeUserId(next.id);
    setKnowledgeError("");
  }

  async function saveKnowledge(): Promise<void> {
    if (krBusyRef.current) return;
    const repo = knowledgeRepoRef.current.trim();
    const branch = knowledgeBranchRef.current.trim();
    const current = readState().user;
    if (!repo) {
      setKnowledgeError(current?.knowledgeRepo ? "연결 해제는 오른쪽의 ‘연결 해제’ 버튼을 사용해 주세요." : "지식 저장소 주소를 입력해 주세요.");
      notify(current?.knowledgeRepo ? "저장소 연결을 해제하려면 오른쪽의 ‘연결 해제’ 버튼을 사용해 주세요." : "지식 저장소 주소를 입력해 주세요.", "warn");
      return;
    }
    if (!isKnowledgeDirty(current, repo, branch)) return;
    setKrBusy(true);
    setKnowledgeError("");
    try {
      const { user: next } = await api<{ user: User }>("/api/me/knowledge-repo", { method: "PUT", body: JSON.stringify({ repo, branch: branch || null }) });
      syncKnowledgeForm(next);
      replaceState({ user: next });
      // The new repo has different plugins; drop the cached listing + close the
      // picker so it can't show the OLD repo's plugin names against the new
      // knowledgeSelected (same reason saveRef/disconnect clear it).
      setKrPickOpen(false);
      setKrContents(null);
      setKrContentsErr("");
      notify(`지식 저장소 "${repo}"을 연결했습니다.`, "ok");
    } catch (err) {
      const message = (err as Error).message;
      setKnowledgeError(message);
      notify(`저장 실패: ${message}`, "warn");
    } finally {
      setKrBusy(false);
    }
  }
  async function refreshKnowledge(): Promise<void> {
    if (krBusyRef.current) return;
    setKrBusy(true);
    try {
      await api("/api/me/knowledge-repo/refresh", { method: "POST" });
      setKrRefreshed(true);
      setTimeout(() => setKrRefreshed(false), 1200);
      notify("지식 저장소를 최신 상태로 새로고침했습니다.", "ok");
    } catch (err) {
      notify(`새로고침 실패: ${(err as Error).message}`, "warn");
    } finally {
      setKrBusy(false);
    }
  }
  async function disconnectKnowledge(): Promise<void> {
    if (krBusyRef.current) return;
    if (!(await confirmAction("지식 저장소 연결을 해제할까요?\nGitHub의 저장소는 삭제되지 않고, 아바타가 더 이상 그 스킬을 불러오지 않습니다."))) return;
    setKrBusy(true);
    try {
      const { user: next } = await api<{ user: User }>("/api/me/knowledge-repo", { method: "PUT", body: JSON.stringify({ repo: null }) });
      syncKnowledgeForm(next);
      replaceState({ user: next });
      setKrPickOpen(false);
      setKrContents(null);
      notify("지식 저장소 연결을 해제했습니다.", "ok");
    } catch (err) {
      notify(`연결 해제 실패: ${(err as Error).message}`, "warn");
    } finally {
      setKrBusy(false);
    }
  }
  async function toggleKrPick(): Promise<void> {
    setKrPickOpen(!krPickOpenRef.current);
    if (!krPickOpenRef.current) return;
    if (!krContentsRef.current && !krContentsLoadingRef.current) await loadKrContents();
    await tick();
    document.getElementById(krContentsId)?.scrollIntoView({ block: "center" });
  }
  async function loadKrContents(): Promise<void> {
    if (krContentsLoadingRef.current) return;
    setKrContentsLoading(true);
    setKrContentsErr("");
    try {
      const { contents } = await api<{ contents: RepoPluginContents }>("/api/me/knowledge-repo/contents");
      setKrContents(contents);
    } catch (err) {
      setKrContentsErr((err as Error).message);
    } finally {
      setKrContentsLoading(false);
    }
  }
  async function saveKrSelection(next: string[] | null): Promise<void> {
    const { user: u } = await api<{ user: User }>("/api/me/knowledge-repo/selected", { method: "PUT", body: JSON.stringify({ selected: next }) });
    replaceState({ user: u });
  }
  async function requestKnowledgeRepo(): Promise<void> {
    if (requestRepoBusyRef.current) return;
    setRequestRepoBusy(true);
    try {
      await openSeededChat("내 지식 저장소를 만들어서 연결해줘. 사내 GitHub에 저장소를 만들고, 앞으로 쓸 기본 지식/스킬 구조까지 준비해줘.");
    } catch (err) {
      notify(`요청 대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setRequestRepoBusy(false);
    }
  }

  // ---- plugins ----
  async function addPlugin(): Promise<void> {
    const repo = pluginRepoRef.current.trim();
    if (pluginAddBusyRef.current || !repo) return;
    setPluginAddBusy(true);
    setPluginAddError("");
    try {
      const { plugin } = await api<{ plugin: Plugin }>("/api/me/plugins", {
        method: "POST",
        body: JSON.stringify({ repo, ref: pluginRefRef.current.trim() || undefined, label: pluginLabelRef.current.trim() || undefined }),
      });
      replaceState({ plugins: [...readState().plugins, plugin] });
      setPluginRepo("");
      setPluginRef("");
      setPluginLabel("");
      notify(`플러그인 "${plugin.label || plugin.repo}"을 추가했습니다.`, "ok");
    } catch (err) {
      const message = (err as Error).message;
      setPluginAddError(message);
      notify(`플러그인 추가 실패: ${message}`, "warn");
    } finally {
      setPluginAddBusy(false);
    }
  }

  async function togglePlugin(p: Plugin, next: boolean): Promise<void> {
    try {
      const { plugin } = await api<{ plugin: Plugin }>(`/api/me/plugins/${encodeURIComponent(p.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: next }),
      });
      replaceState({ plugins: readState().plugins.map((x) => (x.id === plugin.id ? plugin : x)) });
      notify(`"${plugin.label || plugin.repo}" 플러그인을 ${next ? "사용" : "사용 중지"}했습니다.`, "ok");
    } catch (err) {
      // Surface the failure, then re-throw so Toggle keeps the previous visual state.
      notify(`변경 실패: ${(err as Error).message}`, "warn");
      throw err;
    }
  }

  async function refreshPlugin(p: Plugin): Promise<void> {
    if (pluginRowBusyRef.current[p.id]) return;
    setPluginRowBusy({ ...pluginRowBusyRef.current, [p.id]: true });
    try {
      const { plugin } = await api<{ plugin: Plugin }>(`/api/me/plugins/${encodeURIComponent(p.id)}/refresh`, { method: "POST" });
      replaceState({ plugins: readState().plugins.map((x) => (x.id === plugin.id ? plugin : x)) });
      notify(`"${plugin.label || plugin.repo}" 플러그인을 최신 버전으로 새로고침했습니다.`, "ok");
    } catch (err) {
      notify(`새로고침 실패: ${(err as Error).message}`, "warn");
    } finally {
      setPluginRowBusy({ ...pluginRowBusyRef.current, [p.id]: false });
    }
  }

  async function deletePlugin(p: Plugin): Promise<void> {
    if (pluginRowBusyRef.current[p.id]) return;
    if (!(await confirmAction(`"${p.label || p.repo}" 플러그인을 삭제할까요?`))) return;
    setPluginRowBusy({ ...pluginRowBusyRef.current, [p.id]: true });
    try {
      await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      replaceState({ plugins: readState().plugins.filter((x) => x.id !== p.id) });
      notify(`"${p.label || p.repo}" 플러그인을 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      setPluginRowBusy({ ...pluginRowBusyRef.current, [p.id]: false });
    }
  }

  async function toggleRefEdit(p: Plugin): Promise<void> {
    if (refEditIdRef.current === p.id) {
      setRefEditId("");
      return;
    }
    setRefEditId(p.id);
    setRefDraft(p.ref || "");
    setRefSaveError("");
    setOpenPluginId("");
    await tick();
    const panel = document.getElementById(refEditPanelId(p.id));
    panel?.scrollIntoView({ block: "nearest" });
    panel?.querySelector<HTMLInputElement>("input")?.focus();
  }

  async function saveRef(p: Plugin): Promise<void> {
    if (refSaveBusyRef.current) return;
    const next = refDraftRef.current.trim();
    if (next === (p.ref || "")) {
      setRefEditId("");
      return;
    }
    setRefSaveBusy(true);
    setRefSaveError("");
    setPluginRowBusy({ ...pluginRowBusyRef.current, [p.id]: true });
    try {
      const { plugin } = await api<{ plugin: Plugin }>(`/api/me/plugins/${encodeURIComponent(p.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ ref: next || null }),
      });
      replaceState({ plugins: readState().plugins.map((x) => (x.id === plugin.id ? plugin : x)) });
      // The new ref may carry different contents — drop the cached listing.
      const { [p.id]: _dropped, ...rest } = pluginContentsRef.current;
      setPluginContents(rest);
      setPluginContentsErr({ ...pluginContentsErrRef.current, [p.id]: "" });
      try {
        const { plugin: synced } = await api<{ plugin: Plugin }>(`/api/me/plugins/${encodeURIComponent(p.id)}/refresh`, { method: "POST" });
        replaceState({ plugins: readState().plugins.map((x) => (x.id === synced.id ? synced : x)) });
        notify(
          next
            ? `"${plugin.label || plugin.repo}" 플러그인을 "${next}" 브랜치/태그로 전환했습니다.`
            : `"${plugin.label || plugin.repo}" 플러그인을 기본 브랜치로 되돌렸습니다.`,
          "ok",
        );
        setRefEditId("");
      } catch (err) {
        setRefSaveError(`저장은 됐지만 동기화에 실패했습니다: ${summarizeRepoContentsError((err as Error).message)}`);
        notify(`브랜치/태그 동기화 실패: ${(err as Error).message}`, "warn");
      }
    } catch (err) {
      const message = (err as Error).message;
      setRefSaveError(message);
      notify(`브랜치/태그 변경 실패: ${message}`, "warn");
    } finally {
      setRefSaveBusy(false);
      setPluginRowBusy({ ...pluginRowBusyRef.current, [p.id]: false });
    }
  }

  async function togglePluginPick(p: Plugin): Promise<void> {
    if (openPluginIdRef.current === p.id) {
      setOpenPluginId("");
      return;
    }
    setOpenPluginId(p.id);
    setRefEditId("");
    if (!pluginContentsRef.current[p.id]) await loadPluginContents(p);
    await tick();
    document.getElementById(pluginContentsPanelId(p.id))?.scrollIntoView({ block: "center" });
  }
  async function loadPluginContents(p: Plugin): Promise<void> {
    if (pluginContentsLoadingRef.current[p.id]) return;
    setPluginContentsLoading({ ...pluginContentsLoadingRef.current, [p.id]: true });
    setPluginContentsErr({ ...pluginContentsErrRef.current, [p.id]: "" });
    try {
      const { contents } = await api<{ contents: RepoPluginContents }>(`/api/me/plugins/${encodeURIComponent(p.id)}/contents`);
      setPluginContents({ ...pluginContentsRef.current, [p.id]: contents });
    } catch (err) {
      setPluginContentsErr({ ...pluginContentsErrRef.current, [p.id]: (err as Error).message });
    } finally {
      setPluginContentsLoading({ ...pluginContentsLoadingRef.current, [p.id]: false });
    }
  }
  function savePluginSelection(p: Plugin) {
    return async (next: string[] | null): Promise<void> => {
      const { plugin } = await api<{ plugin: Plugin }>(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ selected: next }) });
      replaceState({ plugins: readState().plugins.map((x) => (x.id === plugin.id ? plugin : x)) });
    };
  }

  if (!active || !user) return null;

  const href = user.knowledgeRepo ? repoToHref(user.knowledgeRepo, githubHost) : null;
  const linkText = user.knowledgeRepo + (user.knowledgeBranch ? ` @ ${user.knowledgeBranch}` : "");
  const clearKnowledgeError = (): void => setKnowledgeError("");
  const clearPluginAddError = (): void => setPluginAddError("");

  return (
    <>
      {/* 지식 저장소 */}
      <section className="settings-card">
        <div className="panel-section-head">
          <div>
            <h3>지식 저장소</h3>
            <p className="muted">내 아바타가 일하며 쌓는 지식·스킬을 담는 사내 GitHub({githubHost}) 저장소예요.</p>
          </div>
          {user.knowledgeRepo ? (
            <div className="head-actions">
              <button className="linkish small" type="button" title="노트 사이의 [[링크]] 연결을 그래프로 봅니다" onClick={() => setGraphOpen(true)}>
                그래프 보기
              </button>
              <button className="linkish small" type="button" title="저장소를 원격에서 다시 가져옵니다" disabled={krBusy} onClick={() => void refreshKnowledge()}>
                {krRefreshed ? "새로고침됨 ✓" : "새로고침"}
              </button>
              <button
                className="linkish small danger"
                type="button"
                title="이 저장소 연결을 해제합니다 (GitHub의 저장소 자체는 삭제되지 않습니다)"
                disabled={krBusy}
                onClick={() => void disconnectKnowledge()}
              >
                연결 해제
              </button>
            </div>
          ) : null}
        </div>

        <form
          className="settings-form knowledge-repo-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveKnowledge();
          }}
        >
          <div className="field-row-2col">
            <label className="field">
              <span>저장소 주소</span>
              <input
                value={knowledgeRepo}
                placeholder="owner/repo 또는 사내 git URL"
                aria-describedby={knowledgeStatusId}
                aria-invalid={knowledgeError ? "true" : undefined}
                disabled={krBusy}
                onChange={(event) => {
                  setKnowledgeRepo(event.currentTarget.value);
                  clearKnowledgeError();
                }}
              />
            </label>
            <label className="field">
              <span>브랜치 (선택)</span>
              <input
                value={knowledgeBranch}
                placeholder="비우면 기본 브랜치"
                aria-describedby={knowledgeStatusId}
                disabled={krBusy}
                onChange={(event) => {
                  setKnowledgeBranch(event.currentTarget.value);
                  clearKnowledgeError();
                }}
              />
            </label>
          </div>
          <div className="settings-save-row">
            <span
              id={knowledgeStatusId}
              className={cx("settings-save-status", knowledgeDirty && !krBusy && !knowledgeError && "dirty", krBusy && "pending", Boolean(knowledgeError) && "invalid")}
              role="status"
              aria-live="polite"
            >
              {knowledgeStatus}
            </span>
            <button className="primary" type="submit" disabled={!knowledgeCanSave}>
              {krBusy ? "저장 중…" : savedKnowledgeRepo ? "저장" : "연결"}
            </button>
          </div>
        </form>

        {!user.knowledgeRepo ? (
          <div className="empty-note">
            지식 저장소를 연결하면 아바타가 그 저장소의 지식·스킬을 사용하고, 대화로 직접 관리할 수 있어요.{" "}
            <button className="linkish small" type="button" disabled={requestRepoBusy} onClick={() => void requestKnowledgeRepo()}>
              {requestRepoBusy ? "대화 여는 중…" : "아바타에게 저장소 만들기 요청"}
            </button>
          </div>
        ) : (
          <>
            <div className="kr-link">
              <Icon name="globe" />
              {href ? (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {linkText}
                </a>
              ) : (
                <code>{linkText}</code>
              )}
            </div>
            <div className="git-token-status muted">
              {user.gitTokenSet ? (
                <span className="token-set">● GIT_TOKEN 연결됨 · 아바타가 커밋·푸시할 수 있어요</span>
              ) : (
                <span>
                  GIT_TOKEN이 없어 읽기만 가능해요.{" "}
                  <button className="linkish" type="button" onClick={() => updateState((s) => (s.settingsTab = "access"))}>
                    권한·연결 탭의 Git 자격증명
                  </button>
                  {" "}에서 사내 Git 토큰을 설정하면 아바타가 커밋·푸시할 수 있어요.
                </span>
              )}
            </div>
            <div className="kr-plugins">
              <span className="muted">{!user.knowledgeSelected ? "저장소의 모든 플러그인을 사용 중" : `${user.knowledgeSelected.length}개 플러그인만 사용 중`}</span>
              <button className="linkish small" type="button" aria-expanded={krPickOpen} aria-controls={krContentsId} onClick={() => void toggleKrPick()}>
                사용할 플러그인 선택
              </button>
            </div>
            {krPickOpen && (
              <div id={krContentsId} className="plugin-contents" aria-busy={krContentsLoading ? "true" : "false"}>
                {krContentsLoading ? (
                  <div className="muted" role="status">
                    불러오는 중…
                  </div>
                ) : krContentsErr ? (
                  <div className="error-note" role="alert">
                    조회 실패: {summarizeRepoContentsError(krContentsErr)}{" "}
                    {shouldShowRepoErrorDetails(krContentsErr) && (
                      <details className="error-details">
                        <summary>오류 상세</summary> <code>{krContentsErr}</code>
                      </details>
                    )}{" "}
                    <button className="linkish small" type="button" disabled={krContentsLoading} onClick={() => void loadKrContents()}>
                      다시 시도
                    </button>
                  </div>
                ) : krContents ? (
                  <SettingsPluginSelect
                    info={krContents}
                    selected={user.knowledgeSelected}
                    headText="아바타가 사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다."
                    onSave={saveKrSelection}
                  />
                ) : null}
              </div>
            )}
          </>
        )}
      </section>

      {/* 플러그인 */}
      <section className="settings-card">
        <div className="panel-section-head">
          <div>
            <h3>GitHub 플러그인</h3>
            <p className="muted">내 아바타가 사용할 플러그인. 다른 사용자와의 대화에서는 읽기 전용으로 실행됩니다.</p>
          </div>
        </div>

        <div className="plugin-rows">
          {!plugins.length ? (
            <div className="empty-note">추가한 플러그인이 없습니다.</div>
          ) : (
            plugins.map((p) => (
              <Fragment key={p.id}>
                <div className={cx("plugin-row", (pluginRowBusy[p.id] || pluginContentsLoading[p.id]) && "busy")}>
                  <div className="pr-main">
                    <strong>{p.label || p.repo}</strong> <div className="pr-sub">{p.ref ? `${p.repo} @ ${p.ref}` : p.repo}</div>{" "}
                    <div className="pr-meta muted">
                      {pluginSyncLabel(p)} · {pluginSelSummary(p)}
                    </div>
                  </div>
                  <Toggle on={p.enabled} label={`플러그인 사용: ${p.label || p.repo}`} onChange={(v) => togglePlugin(p, v)} />
                  <button
                    className="msg-act"
                    type="button"
                    aria-label="저장소 내 플러그인 선택"
                    title="저장소 내 플러그인 선택"
                    aria-expanded={openPluginId === p.id}
                    aria-controls={pluginContentsPanelId(p.id)}
                    disabled={Boolean(pluginContentsLoading[p.id])}
                    onClick={() => void togglePluginPick(p)}
                  >
                    <Icon name="menu" />
                  </button>
                  <button
                    className="msg-act"
                    type="button"
                    aria-label={`브랜치/태그 변경: ${p.label || p.repo}`}
                    title="브랜치/태그 변경"
                    aria-expanded={refEditId === p.id}
                    aria-controls={refEditPanelId(p.id)}
                    disabled={Boolean(pluginRowBusy[p.id])}
                    onClick={() => void toggleRefEdit(p)}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className={cx("msg-act", pluginRowBusy[p.id] && "spinning")}
                    type="button"
                    aria-label={`플러그인 최신 버전으로 새로고침: ${p.label || p.repo}`}
                    title="최신 버전으로 새로고침"
                    disabled={Boolean(pluginRowBusy[p.id])}
                    onClick={() => void refreshPlugin(p)}
                  >
                    <Icon name="refresh" />
                  </button>
                  <button
                    className="msg-act danger"
                    type="button"
                    aria-label={`플러그인 삭제: ${p.label || p.repo}`}
                    title="삭제"
                    disabled={Boolean(pluginRowBusy[p.id])}
                    onClick={() => void deletePlugin(p)}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
                {refEditId === p.id && (
                  <div id={refEditPanelId(p.id)} className="plugin-contents">
                    <div className="pc-head">사용할 브랜치·태그를 지정합니다. 비워 두고 저장하면 기본 브랜치를 사용합니다.</div>
                    <form
                      className="plugin-add"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveRef(p);
                      }}
                    >
                      <input
                        value={refDraft}
                        placeholder="브랜치/태그 (비우면 기본 브랜치)"
                        aria-label={`브랜치/태그: ${p.label || p.repo}`}
                        aria-invalid={refSaveError ? "true" : undefined}
                        disabled={refSaveBusy}
                        onChange={(event) => {
                          setRefDraft(event.currentTarget.value);
                          setRefSaveError("");
                        }}
                      />
                      <button className="primary" type="submit" disabled={refSaveBusy}>
                        {refSaveBusy ? "저장 중…" : "저장"}
                      </button>
                    </form>
                    {refSaveError && (
                      <div className="error-note" role="alert">
                        {refSaveError}
                      </div>
                    )}
                  </div>
                )}
                {openPluginId === p.id && (
                  <div id={pluginContentsPanelId(p.id)} className="plugin-contents" aria-busy={pluginContentsLoading[p.id] ? "true" : "false"}>
                    {pluginContentsLoading[p.id] ? (
                      <div className="muted" role="status">
                        저장소 내용을 불러오는 중…
                      </div>
                    ) : pluginContentsErr[p.id] ? (
                      <div className="error-note" role="alert">
                        조회 실패: {summarizeRepoContentsError(pluginContentsErr[p.id])}{" "}
                        {shouldShowRepoErrorDetails(pluginContentsErr[p.id]) && (
                          <details className="error-details">
                            <summary>오류 상세</summary> <code>{pluginContentsErr[p.id]}</code>
                          </details>
                        )}{" "}
                        <button className="linkish small" type="button" disabled={Boolean(pluginContentsLoading[p.id])} onClick={() => void loadPluginContents(p)}>
                          다시 시도
                        </button>
                      </div>
                    ) : pluginContents[p.id] ? (
                      <SettingsPluginSelect
                        info={pluginContents[p.id]}
                        selected={p.selected}
                        headText="사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다."
                        onSave={savePluginSelection(p)}
                      />
                    ) : (
                      <div className="muted">불러오는 중…</div>
                    )}
                  </div>
                )}
              </Fragment>
            ))
          )}
        </div>

        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void addPlugin();
          }}
        >
          <label className="field">
            <span>플러그인 저장소</span>
            <input
              value={pluginRepo}
              placeholder="owner/repo 또는 git URL"
              required
              aria-describedby={pluginAddStatusId}
              aria-invalid={pluginAddError ? "true" : undefined}
              disabled={pluginAddBusy}
              onChange={(event) => {
                setPluginRepo(event.currentTarget.value);
                clearPluginAddError();
              }}
            />
          </label>
          <div className="field-row-2col">
            <label className="field">
              <span>브랜치/태그 (선택)</span>
              <input
                value={pluginRef}
                placeholder="비우면 기본 브랜치"
                aria-describedby={pluginAddStatusId}
                disabled={pluginAddBusy}
                onChange={(event) => {
                  setPluginRef(event.currentTarget.value);
                  clearPluginAddError();
                }}
              />
            </label>
            <label className="field">
              <span>라벨 (선택)</span>
              <input
                value={pluginLabel}
                placeholder="목록에 표시할 이름"
                aria-describedby={pluginAddStatusId}
                disabled={pluginAddBusy}
                onChange={(event) => {
                  setPluginLabel(event.currentTarget.value);
                  clearPluginAddError();
                }}
              />
            </label>
          </div>
          <div className="settings-save-row">
            <span
              id={pluginAddStatusId}
              className={cx("settings-save-status", Boolean(pluginRepoTrimmed && !pluginAddBusy && !pluginAddError) && "dirty", pluginAddBusy && "pending", Boolean(pluginAddError) && "invalid")}
              role="status"
              aria-live="polite"
            >
              {pluginAddStatus}
            </span>
            <button className="primary" type="submit" disabled={!pluginCanAdd}>
              {pluginAddBusy ? "추가 중…" : "플러그인 추가"}
            </button>
          </div>
        </form>
      </section>

      <Presence>{graphOpen && <GraphViewModal key="graph" onClose={() => setGraphOpen(false)} />}</Presence>
    </>
  );
}
