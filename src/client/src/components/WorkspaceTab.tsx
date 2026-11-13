import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import CanvasHtmlFrame from "./CanvasHtmlFrame";
import DrawioDiagram from "./DrawioDiagram";
import Icon from "./Icon";
import { ApiError } from "../lib/api";
import { canvasHtmlDocument } from "../lib/canvasHtml";
import { formatFileSize, renderMarkdown } from "../lib/format";
import { cx, useLatest, useStore } from "../lib/hooks";
import { theme as themeStore } from "../lib/theme";
import { fetchWorkspaceBytes, loadWorkspaceFolder, workspaceFileUrl } from "../lib/workspaceFiles";
import {
  decodeWorkspaceText,
  joinWorkspacePath,
  parseDelimitedText,
  workspaceDisplayName,
  workspaceExtension,
  workspacePreviewKind,
  type WorkspaceEntry,
  type WorkspaceListing,
  type WorkspacePreviewKind,
} from "../../../shared/workspaceFiles";
import type { ChatPane } from "../lib/types";
import "./WorkspaceTab.css";

// The 파일 tab of the side panel: the viewer's OWN sandbox workspace
// (`/workspace`, where the avatar works for them) as a folder tree, with a
// download for every file and a preview of the simple ones. A window for
// PEOPLE and read-only: it sends nothing to the avatar and changes nothing.
//
// Everything listed or shown is the agent's (or a page the agent saved): a
// name is drawn as text, a file as text or through the sanitizers the chat
// already uses (markdown → DOMPurify, html → the canvas's script-less sandboxed
// frame), an image through the file route (never inline data). A link is
// listed and never opened.
//
// It opens on 이 대화 — the conversation's own folder as the root — and 전체
// switches to the whole workspace; a line under the switch says what each one
// shows, so the layout (a folder per conversation under `c/`) need not be known.
//
// One folder is read at a time, when it is opened. While the avatar answers,
// the open folders are re-read every few seconds so files appear as they are
// written; a file's preview is re-read only on 새로고침.
export interface WorkspaceTabProps {
  pane: ChatPane;
  /** This tab is the one the panel shows. */
  active?: boolean;
}

/** What the tree shows: the pane's conversation folder alone, or the whole workspace. */
type WorkspaceScope = "conversation" | "all";

interface FolderState {
  /** `missing`: the server said there is no such folder (a conversation that has made nothing yet). */
  status: "loading" | "ready" | "error" | "missing";
  /** The last listing read — kept while a re-read runs or fails. */
  listing?: WorkspaceListing;
  error?: string;
}

/** How often the open folders are re-read while the avatar is answering. */
const LIVE_REFRESH_MS = 4000;

/** What the well-known folders of the workspace root hold. */
const ROOT_FOLDER_NOTES: Record<string, string> = {
  c: "대화별 작업 폴더",
  uploads: "대화에 첨부한 문서",
  repos: "저장소 작업 사본",
};

const NOTHING_MADE_YET = "이 대화에서는 아직 만든 파일이 없습니다.";

/** What each scope shows, said in the tab: nobody should have to know how the workspace is laid out. */
const SCOPE_NOTES: Record<WorkspaceScope, string> = {
  conversation: "이 대화에서 아바타가 만든 파일입니다. 첨부한 문서와 다른 대화의 파일은 ‘전체’에서 볼 수 있습니다.",
  all: "내 작업 폴더 전체입니다. 대화마다 c 아래에 폴더가 하나씩 생기고, 첨부한 문서는 uploads에 모입니다.",
};

const PREVIEW_REFUSALS: Record<string, string> = {
  TOO_LARGE: "미리보기에는 너무 큰 파일입니다. 다운로드해서 확인해 주세요.",
  BINARY: "이 파일 형식은 미리보기를 제공하지 않습니다. 다운로드해서 확인해 주세요.",
};

function isHidden(entry: WorkspaceEntry): boolean {
  return entry.name.startsWith(".");
}

function entryLabel(entry: WorkspaceEntry, isCurrent: boolean): string {
  if (entry.conversation) return entry.conversation.title || "제목 없는 대화";
  // The conversation on screen is not "deleted" just because it was never saved yet.
  if (isCurrent) return "새 대화";
  if (entry.orphan) return "삭제된 대화";
  return workspaceDisplayName(entry.name);
}

export default function WorkspaceTab({ pane, active = false }: WorkspaceTabProps) {
  // The pane is store state, published again on every streamed token: only the
  // primitives the tree needs go down, so a long listing is not rebuilt per token.
  return <WorkspaceTree conversationId={pane.conversationId} streaming={pane.streaming} active={active} />;
}

/** How many folders one re-read asks for at a time. */
const REREAD_BATCH = 4;

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

const WorkspaceTree = memo(function WorkspaceTree({
  conversationId,
  streaming,
  active,
}: {
  conversationId: string;
  streaming: boolean;
  active: boolean;
}) {
  const [folders, setFolders] = useState<Record<string, FolderState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showHidden, setShowHidden] = useState(false);
  /**
   * 이 대화 (the default) shows the conversation's folder as the root — what a
   * viewer asks first is "what did the avatar make here", and they need not
   * know how the workspace is laid out. 전체 is the whole tree.
   */
  const [scope, setScope] = useState<WorkspaceScope>("conversation");
  /** The conversation's own folder (`c/<segment>`), once the server named it. */
  const [current, setCurrentState] = useState("");
  /** The same path for the passes below, which run between renders. */
  const currentPath = useRef("");
  function setCurrent(path: string): void {
    currentPath.current = path;
    setCurrentState(path);
  }
  const [opened, setOpened] = useState<{ path: string; entry: WorkspaceEntry } | null>(null);
  /** Bumped by 새로고침: the open file is read again. */
  const [previewVersion, setPreviewVersion] = useState(0);
  /** 원문 보기: the open file's source instead of its rendering (offered once the preview says it has both). */
  const [raw, setRaw] = useState(false);
  const [rawOffered, setRawOffered] = useState(false);
  const [busy, setBusy] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const expandedRef = useLatest(expanded);
  const scopeRef = useLatest(scope);
  const conversationRef = useLatest(conversationId);
  /** Per-folder request counter: an older answer never overwrites a newer one. */
  const requests = useRef(new Map<string, number>());
  /** The conversations whose folder was opened by itself (once each: the viewer may fold it again). */
  const revealedFor = useRef(new Set<string>());
  const refreshing = useRef(false);
  /** A re-read asked for while one runs: it runs once more afterwards (`loud` = the viewer pressed 새로고침). */
  const rerun = useRef<"quiet" | "loud" | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function forget(path: string): void {
    const inside = (candidate: string): boolean => candidate === path || candidate.startsWith(`${path}/`);
    setExpanded((prev) => new Set([...prev].filter((item) => !inside(item))));
    setFolders((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => !inside(key))));
  }

  /** Read one folder. `quiet`: a re-read that keeps showing the last listing meanwhile. */
  async function loadFolder(path: string, quiet = false): Promise<WorkspaceListing | null> {
    const request = (requests.current.get(path) ?? 0) + 1;
    requests.current.set(path, request);
    const stale = (): boolean => !alive.current || requests.current.get(path) !== request;
    if (!quiet) setFolders((prev) => ({ ...prev, [path]: { status: "loading", listing: prev[path]?.listing } }));
    try {
      const listing = await loadWorkspaceFolder(path, conversationRef.current);
      if (stale()) return null;
      setFolders((prev) => ({ ...prev, [path]: { status: "ready", listing } }));
      return listing;
    } catch (err) {
      if (stale()) return null;
      if (path && err instanceof ApiError && err.status === 404) {
        forget(path); // the folder went away (the agent removed it) — or was never made
        setFolders((prev) => ({ ...prev, [path]: { status: "missing" } }));
        return null;
      }
      const error = err instanceof Error ? err.message : "폴더를 불러오지 못했습니다.";
      setFolders((prev) => ({ ...prev, [path]: { status: "error", listing: prev[path]?.listing, error } }));
      return null;
    }
  }

  /**
   * Read the root (it names the conversation's folder), then what the scope
   * shows first. 이 대화: that folder — a conversation that has made nothing
   * yet has none, which is recorded, not an error. 전체: the first time the
   * folder exists, open the way to it (`c`, then the folder); the next re-read
   * tries again while it does not.
   */
  async function loadRoot(quiet: boolean): Promise<void> {
    const forConversation = conversationRef.current;
    const root = await loadFolder("", quiet);
    if (!root || forConversation !== conversationRef.current) return;
    const mine = root.current ?? "";
    setCurrent(mine);
    if (scopeRef.current === "conversation") {
      if (!mine) return;
      if (root.exists) await loadFolder(mine, quiet);
      else setFolders((prev) => ({ ...prev, [mine]: { status: "missing" } }));
      return;
    }
    if (!mine || revealedFor.current.has(forConversation)) return;
    if (!root.entries.some((entry) => entry.name === "c" && entry.kind === "dir")) return;
    const conversations = await loadFolder("c", quiet || expandedRef.current.has("c"));
    const name = mine.slice(mine.lastIndexOf("/") + 1);
    if (!conversations?.entries.some((entry) => entry.name === name && entry.kind === "dir")) return;
    if (forConversation !== conversationRef.current) return;
    revealedFor.current.add(forConversation);
    setExpanded((prev) => new Set([...prev, "c", mine]));
    void loadFolder(mine, quiet);
  }

  /**
   * The unfolded folders that are on screen in this scope: below the scope's
   * top folder, with every folder on the way unfolded too. (A folder unfolded
   * in one scope can sit under a folded one in the other.)
   */
  function visiblePaths(): string[] {
    const open = expandedRef.current;
    const top = scopeRef.current === "conversation" ? currentPath.current : "";
    if (scopeRef.current === "conversation" && !top) return [];
    return [...open].filter((path) => {
      if (top && !path.startsWith(`${top}/`)) return false;
      for (let parent = parentOf(path); parent !== top; parent = parentOf(parent)) {
        if (!parent || !open.has(parent)) return false;
      }
      return true;
    });
  }

  /**
   * Re-read the root and every unfolded folder, a few at a time. One pass runs
   * at a time; a re-read asked for meanwhile (another conversation in the pane,
   * the answer ending, 새로고침) is not dropped — one more pass follows.
   */
  async function refresh(quiet: boolean): Promise<void> {
    if (!quiet) setBusy(true);
    if (refreshing.current) {
      rerun.current = quiet && rerun.current !== "loud" ? "quiet" : "loud";
      return;
    }
    refreshing.current = true;
    try {
      for (let pass = quiet; alive.current; ) {
        await loadRoot(pass);
        const open = visiblePaths();
        for (let i = 0; i < open.length; i += REREAD_BATCH) {
          await Promise.all(open.slice(i, i + REREAD_BATCH).map((path) => loadFolder(path, true)));
        }
        const again = rerun.current;
        rerun.current = null;
        if (!again) break;
        pass = again === "quiet";
      }
    } finally {
      refreshing.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const refreshRef = useLatest(refresh);

  // A new conversation in the pane: the same workspace, another "current"
  // folder (the old one must not show as this conversation's meanwhile). The
  // other scope: read what it shows.
  const shownConversation = useRef(conversationId);
  useEffect(() => {
    if (shownConversation.current !== conversationId) {
      shownConversation.current = conversationId;
      setCurrent("");
    }
    void refreshRef.current(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, scope]);

  // While the avatar answers, files appear: re-read what is open, and once more when it ends.
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current && !streaming) void refreshRef.current(true);
    wasStreaming.current = streaming;
    if (!streaming || !active) return;
    const timer = setInterval(() => {
      // Not while the panel is folded away or the browser tab is in the background.
      if (document.hidden || !rootRef.current?.getClientRects().length) return;
      void refreshRef.current(true);
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, active]);

  function toggleFolder(path: string): void {
    if (expanded.has(path)) {
      // Folding a folder folds what is inside it: `expanded` is exactly what is on screen, so a re-read asks for nothing hidden.
      setExpanded((prev) => new Set([...prev].filter((item) => item !== path && !item.startsWith(`${path}/`))));
      return;
    }
    setExpanded((prev) => new Set([...prev, path]));
    void loadFolder(path, Boolean(folders[path]?.listing));
  }

  async function onRefresh(): Promise<void> {
    const target = opened;
    if (target) {
      // The file may have grown or shrunk past a preview cap: judge it by its size now.
      const listing = await loadFolder(parentOf(target.path), true);
      if (!alive.current) return;
      const entry = listing?.entries.find((item) => item.name === target.entry.name && item.kind === "file");
      if (entry) setOpened((prev) => (prev?.path === target.path ? { path: prev.path, entry } : prev));
      setPreviewVersion((value) => value + 1);
    }
    void refresh(false);
  }

  // Keyboard focus follows the view: into the open file, and back onto its row.
  const openedPath = opened?.path ?? "";
  const returnTo = useRef("");
  useEffect(() => {
    if (openedPath) {
      returnTo.current = openedPath;
      backRef.current?.focus();
      return;
    }
    const path = returnTo.current;
    returnTo.current = "";
    if (!path) return;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>("[data-ws-path]") ?? [];
    for (const row of Array.from(rows)) {
      if (row.dataset.wsPath === path) {
        row.focus();
        break;
      }
    }
  }, [openedPath]);

  function showFile(next: { path: string; entry: WorkspaceEntry } | null): void {
    setRaw(false);
    setRawOffered(false);
    setOpened(next);
  }

  /** 이 대화: the conversation's folder as the root, or why there is nothing to show yet. */
  function renderConversation(): ReactNode {
    const root = folders[""];
    if (!current) {
      return root?.status === "error" ? (
        <p className="ws-note ws-note-error">{root.error}</p>
      ) : (
        <p className="ws-note muted">불러오는 중…</p>
      );
    }
    if ((root?.listing && !root.listing.exists) || folders[current]?.status === "missing") {
      return <p className="ws-note muted">{NOTHING_MADE_YET}</p>;
    }
    return renderFolder(current, 0, NOTHING_MADE_YET);
  }

  function renderFolder(path: string, depth: number, emptyText = "비어 있습니다."): ReactNode {
    const state = folders[path];
    const listing = state?.listing;
    if (!listing) {
      return (
        <p className="ws-note muted" style={{ paddingInlineStart: `${depth * 14 + 22}px` }}>
          {state?.status === "error" ? state.error : "불러오는 중…"}
        </p>
      );
    }
    let entries = showHidden ? listing.entries : listing.entries.filter((entry) => !isHidden(entry));
    // The conversation on screen leads its siblings.
    if (path === "c" && current) {
      const mine = entries.find((entry) => joinWorkspacePath(path, entry.name) === current);
      if (mine) entries = [mine, ...entries.filter((entry) => entry !== mine)];
    }
    const hiddenCount = listing.entries.length - entries.length;
    return (
      <>
        {state?.status === "error" ? (
          <p className="ws-note ws-note-error" style={{ paddingInlineStart: `${depth * 14 + 22}px` }}>
            {state.error}
          </p>
        ) : null}
        {entries.length ? (
          <ul className="ws-list">
            {entries.map((entry) => renderEntry(joinWorkspacePath(path, entry.name), entry, depth))}
          </ul>
        ) : (
          <p className="ws-note muted" style={{ paddingInlineStart: `${depth * 14 + 22}px` }}>
            {!listing.exists
              ? "아직 작업 폴더가 없습니다. 아바타와 대화를 시작하면 만들어집니다."
              : hiddenCount
                ? `숨김 항목 ${hiddenCount}개만 있습니다.`
                : emptyText}
          </p>
        )}
        {listing.truncated ? (
          <p className="ws-note muted" style={{ paddingInlineStart: `${depth * 14 + 22}px` }}>
            항목 {listing.total.toLocaleString("ko-KR")}개{listing.totalIsMinimum ? " 이상" : ""} 중{" "}
            {listing.entries.length.toLocaleString("ko-KR")}개만 표시합니다.
          </p>
        ) : null}
      </>
    );
  }

  function renderEntry(path: string, entry: WorkspaceEntry, depth: number): ReactNode {
    const isCurrent = path === current && entry.kind === "dir";
    const label = entryLabel(entry, isCurrent);
    const indent = { paddingInlineStart: `${depth * 14}px` };
    const note = !path.includes("/") && entry.kind === "dir" ? ROOT_FOLDER_NOTES[entry.name] : undefined;
    const renamed = Boolean(entry.conversation || entry.orphan || isCurrent);
    if (entry.kind === "dir") {
      const open = expanded.has(path);
      return (
        <li key={entry.name}>
          <div className={cx("ws-row", isCurrent && "ws-row-current")} style={indent}>
            <button
              className="ws-row-main"
              type="button"
              aria-expanded={open}
              title={`/workspace/${path}`}
              onClick={() => toggleFolder(path)}
            >
              <span className="ws-caret">
                <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
              </span>
              <span className="ws-icon">
                <Icon name="folder" size={14} />
              </span>
              <span className="ws-name">{label}</span>
              {isCurrent ? <span className="ws-badge">현재 대화</span> : null}
              {renamed ? <span className="ws-sub muted">{workspaceDisplayName(entry.name).slice(0, 8)}</span> : null}
              {note ? <span className="ws-sub muted">{note}</span> : null}
            </button>
          </div>
          {open ? renderFolder(path, depth + 1) : null}
        </li>
      );
    }
    if (entry.kind === "file") {
      return (
        <li key={entry.name}>
          <div className="ws-row" style={indent}>
            <button
              className="ws-row-main"
              type="button"
              title={`/workspace/${path}`}
              data-ws-path={path}
              onClick={() => showFile({ path, entry })}
            >
              <span className="ws-caret"></span>
              <span className="ws-icon">
                <Icon name={workspacePreviewKind(entry.name, entry.size ?? 0) === "image" ? "image" : "file"} size={14} />
              </span>
              <span className="ws-name">{label}</span>
            </button>
            <span className="ws-size muted">{formatFileSize(entry.size) || "0 B"}</span>
            <a
              className="ws-download"
              href={workspaceFileUrl(path)}
              download={entry.name}
              draggable={false}
              aria-label={`다운로드: ${label}`}
              title="다운로드"
            >
              <Icon name="download" size={14} />
            </a>
          </div>
        </li>
      );
    }
    // A link (or a socket, a device): shown so the folder reads complete, never opened.
    return (
      <li key={entry.name}>
        <div className="ws-row ws-row-inert" style={indent} title={`/workspace/${path}`}>
          <span className="ws-row-main">
            <span className="ws-caret"></span>
            <span className="ws-icon">
              <Icon name="link" size={14} />
            </span>
            <span className="ws-name">{label}</span>
            <span className="ws-sub muted">{entry.kind === "link" ? "링크 · 열 수 없음" : "열 수 없음"}</span>
          </span>
        </div>
      </li>
    );
  }

  const openedName = opened ? workspaceDisplayName(opened.entry.name) : "";

  return (
    <div className="canvas-card workspace-tab cmp-workspace-tab" ref={rootRef}>
      {/* The tree stays mounted behind an open file: what was unfolded is still unfolded on the way back. */}
      <div hidden={Boolean(opened)}>
        <div className="canvas-card-top">
          <div className="file-tab-title">
            <div className="canvas-title">작업 폴더</div>
            <span className="muted file-tab-size ws-subtitle" title="아바타가 내 요청을 처리하며 쓰는 폴더입니다. 여기서는 보기와 다운로드만 됩니다.">
              보기 전용 · {scope === "conversation" && current ? `/workspace/${current}` : "/workspace"}
            </span>
          </div>
          <div className="canvas-toolbar">
            <button
              className="canvas-tool-btn"
              type="button"
              aria-pressed={showHidden}
              title="이름이 점(.)으로 시작하는 항목 보기"
              onClick={() => setShowHidden((value) => !value)}
            >
              숨김 항목
            </button>
            <button className="canvas-tool-btn" type="button" disabled={busy} onClick={() => void onRefresh()}>
              새로고침
            </button>
          </div>
        </div>
        <div className="ws-scope" role="group" aria-label="보기 범위">
          {(["conversation", "all"] as const).map((item) => (
            <button
              key={item}
              className={cx("ws-scope-btn", scope === item && "active")}
              type="button"
              aria-pressed={scope === item}
              onClick={() => setScope(item)}
            >
              {item === "conversation" ? "이 대화" : "전체"}
            </button>
          ))}
        </div>
        <p className="ws-note ws-scope-note muted">{SCOPE_NOTES[scope]}</p>
        <div className="canvas-content ws-tree">{scope === "conversation" ? renderConversation() : renderFolder("", 0)}</div>
      </div>
      {opened ? (
        <div>
          <div className="canvas-card-top">
            <button className="canvas-tool-btn ws-back" type="button" ref={backRef} onClick={() => showFile(null)}>
              <Icon name="back" size={12} /> 목록
            </button>
            <div className="file-tab-title">
              <div className="canvas-title" title={`/workspace/${opened.path}`}>
                {openedName}
              </div>
              <span className="muted file-tab-size ws-subtitle" title={`/workspace/${opened.path}`}>
                {[formatFileSize(opened.entry.size) || "0 B", `/workspace/${workspaceDisplayName(opened.path)}`].join(" · ")}
              </span>
            </div>
            <div className="canvas-toolbar">
              {rawOffered ? (
                <button className="canvas-tool-btn" type="button" aria-pressed={raw} onClick={() => setRaw((value) => !value)}>
                  원문 보기
                </button>
              ) : null}
              <button className="canvas-tool-btn" type="button" onClick={() => void onRefresh()}>
                새로고침
              </button>
              <a
                className="canvas-tool-btn"
                href={workspaceFileUrl(opened.path)}
                download={opened.entry.name}
                draggable={false}
              >
                다운로드
              </a>
            </div>
          </div>
          <WorkspacePreview
            key={`${opened.path}\n${previewVersion}`}
            path={opened.path}
            entry={opened.entry}
            version={previewVersion}
            active={active}
            raw={raw}
            onRawOffered={setRawOffered}
          />
        </div>
      ) : null}
    </div>
  );
});

type PreviewState =
  | { status: "loading" }
  | { status: "text"; text: string }
  | { status: "none"; message: string };

const RAW_TOGGLE_KINDS: ReadonlySet<WorkspacePreviewKind> = new Set(["markdown", "html", "csv", "json", "drawio"]);

/** One file drawn by its kind. Remounted (by key) for another file or a re-read. */
function WorkspacePreview({
  path,
  entry,
  version,
  active,
  raw,
  onRawOffered,
}: {
  path: string;
  entry: WorkspaceEntry;
  version: number;
  active: boolean;
  /** Show the source instead of the rendering. */
  raw: boolean;
  /** Whether this file has both a rendering and a source to switch between. */
  onRawOffered: (offered: boolean) => void;
}) {
  const kind = workspacePreviewKind(entry.name, entry.size ?? 0);
  const refusal = PREVIEW_REFUSALS[kind];
  const textual = !refusal && kind !== "image";
  const [state, setState] = useState<PreviewState>(() =>
    refusal ? { status: "none", message: refusal } : { status: "loading" },
  );
  const [imageFailed, setImageFailed] = useState(false);
  const resolvedTheme = useStore(themeStore);
  const rawOffered = state.status === "text" && RAW_TOGGLE_KINDS.has(kind as WorkspacePreviewKind);
  useEffect(() => {
    onRawOffered(rawOffered);
    // The parent's setter is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawOffered]);

  useEffect(() => {
    if (!textual) return;
    const controller = new AbortController();
    fetchWorkspaceBytes(path, controller.signal).then(
      (bytes) => {
        const text = decodeWorkspaceText(bytes);
        setState(text === null ? { status: "none", message: PREVIEW_REFUSALS.BINARY } : { status: "text", text });
      },
      (err: unknown) => {
        if ((err as Error)?.name === "AbortError") return;
        setState({ status: "none", message: err instanceof Error ? err.message : "파일을 불러오지 못했습니다." });
      },
    );
    return () => controller.abort();
    // One read per mount: the parent remounts this for another file or a re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const text = state.status === "text" ? state.text : "";
  const rendered = useMemo((): ReactNode => {
    if (state.status !== "text" || raw) return null;
    if (kind === "markdown") {
      // Another hand's text: no inline style, so it cannot position itself over the app.
      return (
        <div
          className="md html-container"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text, { forbidInlineStyle: true }) }}
        />
      );
    }
    if (kind === "html") return <CanvasHtmlFrame doc={canvasHtmlDocument(text, resolvedTheme)} title={entry.name} />;
    if (kind === "csv") {
      const table = parseDelimitedText(text, workspaceExtension(entry.name) === "tsv" ? "\t" : ",");
      if (!table.rows.length) return <p className="muted">내용이 없습니다.</p>;
      const [head, ...body] = table.rows;
      return (
        <>
          <div className="ws-table-wrap">
            <table className="ws-table">
              <thead>
                <tr>
                  {head.map((cell, index) => (
                    <th key={index}>{cell}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, index) => (
                      <td key={index}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {table.truncated ? <p className="ws-note muted">표의 앞부분만 표시합니다. 전체는 다운로드해서 확인해 주세요.</p> : null}
        </>
      );
    }
    if (kind === "json") {
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* not valid JSON: shown as written */
      }
      return <pre className="ws-text">{pretty}</pre>;
    }
    return null;
    // `state` is replaced, never mutated; `text` covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, raw, kind, resolvedTheme, entry.name]);

  let body: ReactNode;
  if (kind === "image") {
    body = imageFailed ? (
      <p className="muted">이미지를 표시할 수 없습니다. 다운로드해서 확인해 주세요.</p>
    ) : (
      <figure className="file-preview-slide">
        <img src={workspaceFileUrl(path, true, version)} alt={workspaceDisplayName(entry.name)} onError={() => setImageFailed(true)} />
      </figure>
    );
  } else if (state.status === "loading") {
    body = <p className="muted">불러오는 중…</p>;
  } else if (state.status === "none") {
    body = <p className="muted">{state.message}</p>;
  } else if (kind === "drawio" && !raw) {
    body = <DrawioDiagram xml={text} active={active} />;
  } else {
    body = rendered ?? <pre className="ws-text">{text}</pre>;
  }

  return (
    <div className="canvas-content file-tab-body ws-preview">{body}</div>
  );
}
