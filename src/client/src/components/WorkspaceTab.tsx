import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import CanvasHtmlFrame from "./CanvasHtmlFrame";
import DrawioDiagram from "./DrawioDiagram";
import Icon from "./Icon";
import { ApiError } from "../lib/api";
import { canvasHtmlDocument } from "../lib/canvasHtml";
import { formatFileSize, renderMarkdown } from "../lib/format";
import { takeWorkspaceReveal, workspaceFileGone } from "../lib/chat";
import { cx, useAppState, useLatest, useStore } from "../lib/hooks";
import { theme as themeStore } from "../lib/theme";
import {
  fetchWorkspaceBytes,
  loadWorkspaceDocumentPreview,
  loadWorkspaceFolder,
  workspaceFileUrl,
  workspacePreviewPageUrl,
} from "../lib/workspaceFiles";
import {
  WORKSPACE_DOCUMENT_PREVIEW_MAX_PAGES,
  decodeWorkspaceText,
  joinWorkspacePath,
  parseDelimitedText,
  workspaceDisplayName,
  workspaceExtension,
  workspacePreviewKind,
  type WorkspaceDocumentPreviewFailure,
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
// frame), an image through the file route (never inline data), a pdf, pptx or
// docx as page images the SERVER renders (`workspacePreviews.ts`). A link is
// listed and never opened.
//
// The tree is the workspace root with ONE change: `c/`, which holds a folder
// per conversation, is replaced by this conversation's own folder, pinned at
// the top and unfolded. The folders every conversation shares (`uploads`,
// `repos`, …) stay where they are; the other conversations' folders show only
// behind 다른 대화. A line above the tree says so, so the layout need not be
// known.
//
// One folder is read at a time, when it is opened. While an avatar answers —
// in ANY pane of a split, not only the one the panel serves — the open folders
// are re-read every few seconds so files appear as they are written; a file's
// preview is re-read only on 새로고침.
//
// A shared file's card can point here (작업 폴더에서 보기, the viewer's press):
// the tree unfolds down to where that file sat when it was shared and marks its
// row. The card holds a copy; this is the file as it is NOW — or a line saying
// it is no longer there.
export interface WorkspaceTabProps {
  pane: ChatPane;
  /** This tab is the one the panel shows. */
  active?: boolean;
}

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

/** A card pointed at a file that is not (or no longer) where it was shared from. */
const REVEAL_GONE =
  "작업 폴더에서 이 파일을 찾지 못했습니다. 전달한 뒤에 옮겨졌거나 지워졌을 수 있습니다. 카드의 다운로드는 전달한 시점의 사본이라 그대로 받을 수 있습니다.";
const REVEAL_TOO_MANY = "폴더의 항목이 너무 많아 이 파일을 목록에서 찾지 못했습니다. 카드의 다운로드로 받아 주세요.";

/** What the tree shows, said in the tab: nobody should have to know how the workspace is laid out. */
const TREE_NOTE = "맨 위는 이 대화의 작업 폴더이고, 그 아래는 모든 대화가 함께 쓰는 폴더입니다. 첨부한 문서는 uploads에 모입니다.";

const PREVIEW_REFUSALS: Record<string, string> = {
  TOO_LARGE: "미리보기에는 너무 큰 파일입니다. 다운로드해서 확인해 주세요.",
  BINARY: "이 파일 형식은 미리보기를 제공하지 않습니다. 다운로드해서 확인해 주세요.",
};

/** Why a pdf, pptx or docx has no page images. */
const DOCUMENT_FAILURES: Record<WorkspaceDocumentPreviewFailure, string> = {
  UNAVAILABLE: "이 서버에서는 문서 미리보기를 제공하지 않습니다. 다운로드해서 확인해 주세요.",
  TOO_LARGE: PREVIEW_REFUSALS.TOO_LARGE,
  BAD_FORMAT: "파일 내용이 확장자와 맞지 않아 미리보기를 만들 수 없습니다. 다운로드해서 확인해 주세요.",
  RENDER_FAILED: "미리보기를 만들지 못했습니다. 새로고침으로 다시 시도하거나 다운로드해서 확인해 주세요.",
};
/** How often the tab asks whether a document's pages are ready, and for how long. */
const DOCUMENT_POLL_MS = 2000;
const DOCUMENT_POLL_LIMIT_MS = 5 * 60_000;

function isHidden(entry: WorkspaceEntry): boolean {
  return entry.name.startsWith(".");
}

function entryLabel(entry: WorkspaceEntry): string {
  if (entry.conversation) return entry.conversation.title || "제목 없는 대화";
  if (entry.orphan) return "삭제된 대화";
  return workspaceDisplayName(entry.name);
}

export default function WorkspaceTab({ pane, active = false }: WorkspaceTabProps) {
  // How many panes have an avatar answering right now — ANY pane, not only the
  // one the panel serves: the workspace is the user's, and in split view a pane
  // that is not the active one writes into it just the same (its files land in
  // `uploads`, `repos` or its own folder, all of which this tree can show).
  const answering = Math.max(
    useAppState().chatPanes.filter((item) => item.streaming).length,
    pane.streaming ? 1 : 0, // a pane the store does not hold (a test, a pane being replaced)
  );
  // The pane is store state, published again on every streamed token: only the
  // primitives the tree needs go down, so a long listing is not rebuilt per token.
  return (
    <WorkspaceTree
      paneId={pane.id}
      conversationId={pane.conversationId}
      answering={answering}
      active={active}
      revealPath={pane.workspaceReveal?.path ?? ""}
      revealNonce={pane.workspaceReveal?.nonce ?? 0}
      // A new object per ask, never changed afterwards: it does not move per token either.
      revealAsk={pane.workspaceReveal}
    />
  );
}

/** How many folders one re-read asks for at a time. */
const REREAD_BATCH = 4;

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

const WorkspaceTree = memo(function WorkspaceTree({
  paneId,
  conversationId,
  answering,
  active,
  revealPath,
  revealNonce,
  revealAsk,
}: {
  paneId: string;
  conversationId: string;
  /** Panes whose avatar is answering right now (any pane of the split). */
  answering: number;
  active: boolean;
  /** A card's 작업 폴더에서 보기: the workspace path to unfold the tree down to (`revealNonce` 0 = no ask). */
  revealPath: string;
  revealNonce: number;
  /** The same ask, whole: whether to OPEN the file (a card click) and what to show if it is gone. */
  revealAsk?: ChatPane["workspaceReveal"];
}) {
  const [folders, setFolders] = useState<Record<string, FolderState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showHidden, setShowHidden] = useState(false);
  /**
   * 다른 대화: also list `c`, the folder that holds every conversation's
   * work folder. Off by default — the tree shows THIS conversation's folder
   * (pinned at the top) next to the folders every conversation shares
   * (`uploads`, `repos`, …); the other conversations' folders are only noise
   * here.
   */
  const [showOthers, setShowOthers] = useState(false);
  /** The conversation's own folder (`c/<segment>`), once the server named it. */
  const [current, setCurrentState] = useState("");
  /** The same path for the passes below, which run between renders. */
  const currentPath = useRef("");
  function setCurrent(path: string): void {
    currentPath.current = path;
    setCurrentState(path);
  }
  const [opened, setOpened] = useState<{ path: string; entry: WorkspaceEntry } | null>(null);
  /** The file being opened was not the viewer's press: its preview does not take the keyboard focus. */
  const quietOpen = useRef(false);
  /** Bumped by 새로고침: the open file is read again. */
  const [previewVersion, setPreviewVersion] = useState(0);
  /** 원문 보기: the open file's source instead of its rendering (offered once the preview says it has both). */
  const [raw, setRaw] = useState(false);
  const [rawOffered, setRawOffered] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The file a card pointed at: its row is marked until the viewer opens a file or another card points. */
  const [marked, setMarked] = useState("");
  /** Why a card's file could not be pointed at (said above the tree). */
  const [notice, setNotice] = useState("");
  /** Bumped when a row was marked: keyboard focus goes onto it once it is drawn. */
  const [markedTick, setMarkedTick] = useState(0);
  const handledReveal = useRef(0);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const expandedRef = useLatest(expanded);
  const showOthersRef = useLatest(showOthers);
  const foldersRef = useLatest(folders);
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
   * Read the root (it names the conversation's folder), then that folder: it
   * is pinned at the top of the tree and unfolded by itself — once per
   * conversation, and again when a folder that did not exist appears. A
   * conversation that has made nothing yet has none: recorded as `missing`,
   * never an error, and asked for again on every pass.
   */
  async function loadRoot(quiet: boolean): Promise<void> {
    const forConversation = conversationRef.current;
    const root = await loadFolder("", quiet);
    if (!root || forConversation !== conversationRef.current) return;
    const mine = root.current ?? "";
    setCurrent(mine);
    if (!mine) return;
    const first = !revealedFor.current.has(forConversation);
    const wasMissing = foldersRef.current[mine]?.status === "missing";
    if (!first && !wasMissing && !expandedRef.current.has(mine)) return; // the viewer folded it
    revealedFor.current.add(forConversation);
    if (!root.exists) {
      setFolders((prev) => ({ ...prev, [mine]: { status: "missing" } }));
      return;
    }
    const listing = await loadFolder(mine, quiet);
    if (listing && (first || wasMissing) && forConversation === conversationRef.current) {
      setExpanded((prev) => new Set([...prev, mine]));
    }
  }

  /**
   * The unfolded folders that are on screen, other than the conversation's own
   * (`loadRoot` reads that one): every folder on the way up is unfolded too,
   * up to a top-level row — the pinned conversation folder, or an entry of the
   * root (`c` only while 다른 대화 is on).
   */
  function visiblePaths(): string[] {
    const open = expandedRef.current;
    const mine = currentPath.current;
    return [...open].filter((path) => {
      if (path === mine) return false;
      for (let at = path; ; ) {
        if (at === mine) return true;
        const parent = parentOf(at);
        if (parent === "") return at !== "c" || showOthersRef.current;
        if (!open.has(parent)) return false;
        at = parent;
      }
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
  // folder (the old one must not show as this conversation's meanwhile).
  const shownConversation = useRef(conversationId);
  useEffect(() => {
    if (shownConversation.current !== conversationId) {
      shownConversation.current = conversationId;
      setCurrent("");
    }
    void refreshRef.current(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // While an avatar answers — in any pane — files appear: re-read what is on
  // screen, and once more each time one of the answers ends.
  const wasAnswering = useRef(answering);
  useEffect(() => {
    if (answering < wasAnswering.current) void refreshRef.current(true);
    wasAnswering.current = answering;
    if (!answering || !active) return;
    const timer = setInterval(() => {
      // Not while the panel is folded away or the browser tab is in the background.
      if (document.hidden || !rootRef.current?.getClientRects().length) return;
      void refreshRef.current(true);
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answering, active]);

  /**
   * A card's 작업 폴더에서 보기: read every folder on the way to `target`, unfold
   * them and mark the file's row. The folders are read here rather than through
   * `loadFolder`, whose answer is dropped when a re-read pass asks for the same
   * folder meanwhile. A file that is not there any more is said, never an error:
   * the tree still unfolds as far as the folders exist.
   */
  async function reveal(target: string, ask?: ChatPane["workspaceReveal"]): Promise<void> {
    const forConversation = conversationRef.current;
    const parts = target.split("/");
    const name = parts.pop() ?? "";
    const chain = ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
    showFile(null);
    setNotice("");
    const read: Record<string, FolderState> = {};
    let last: WorkspaceListing | null = null;
    let problem = "";
    for (const folder of chain) {
      try {
        last = await loadWorkspaceFolder(folder, forConversation);
        read[folder] = { status: "ready", listing: last };
      } catch (err) {
        last = null;
        problem =
          err instanceof ApiError && err.status === 404
            ? REVEAL_GONE
            : err instanceof Error
              ? err.message
              : "폴더를 불러오지 못했습니다.";
      }
      if (!alive.current || forConversation !== conversationRef.current) return;
      if (!last) break;
    }
    const mine = read[""]?.listing?.current ?? currentPath.current;
    if (mine) setCurrent(mine);
    setFolders((prev) => ({ ...prev, ...read }));
    // What must be unfolded for the row to be on screen: under this
    // conversation's folder that folder is itself a top-level row (`c` is not
    // shown); another conversation's file sits behind 다른 대화.
    const inMine = Boolean(mine) && target.startsWith(`${mine}/`);
    const unfold = Object.keys(read).filter((folder) => folder !== "" && (!inMine || folder === mine || folder.startsWith(`${mine}/`)));
    setExpanded((prev) => new Set([...prev, ...unfold]));
    if (!inMine && parts[0] === "c") setShowOthers(true);
    if ([...parts, name].some((segment) => segment.startsWith("."))) setShowHidden(true);
    const entry = last?.entries.find((item) => item.name === name && item.kind === "file");
    if (entry) {
      if (ask?.open) {
        // A card click: the file itself, drawn here. The tree behind it is
        // unfolded down to its row, which takes the focus on the way back.
        quietOpen.current = Boolean(ask.quiet);
        showFile({ path: target, entry });
        return;
      }
      setMarked(target);
      setMarkedTick((value) => value + 1);
      return;
    }
    setMarked("");
    if (ask?.open && ask.fallback) {
      // The card still holds the copy it was shared as: its own tab shows that, and says why.
      workspaceFileGone(paneId, ask.fallback, Boolean(ask.quiet));
      return;
    }
    setNotice(problem || (last?.truncated ? REVEAL_TOO_MANY : REVEAL_GONE));
  }
  const revealRef = useLatest(reveal);

  // The ask is one-shot: taken from the pane as soon as it is seen, so a tab
  // closed and reopened does not point again.
  useEffect(() => {
    if (!revealNonce || handledReveal.current === revealNonce) return;
    handledReveal.current = revealNonce;
    takeWorkspaceReveal(paneId, revealNonce);
    void revealRef.current(revealPath, revealAsk?.nonce === revealNonce ? revealAsk : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce]);

  // The marked row, once drawn, takes keyboard focus (which also scrolls it
  // into view): the button that asked sits in a tab that is hidden now.
  useEffect(() => {
    if (!markedTick || !marked) return;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>("[data-ws-path]") ?? [];
    for (const row of Array.from(rows)) {
      if (row.dataset.wsPath === marked) {
        row.focus();
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markedTick]);

  // The line saying a file is gone sits above the tree, which may be scrolled
  // far down: focus brings it into view, like the marked row.
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

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
    setNotice("");
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
      // A file that opened by itself (a live .drawio share) leaves the keyboard where the viewer is typing.
      if (quietOpen.current) quietOpen.current = false;
      else backRef.current?.focus();
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
    setPreviewVersion(0); // a file opened afresh is not a 새로고침 of the last one
    if (next) {
      setMarked("");
      setNotice("");
    }
    setOpened(next);
  }

  /** The conversation's own folder, pinned as the first row of the tree. */
  function renderCurrent(): ReactNode {
    if (!current) return null;
    const root = folders[""]?.listing;
    const missing = folders[current]?.status === "missing" || (root ? !root.exists : false);
    const open = !missing && expanded.has(current);
    return (
      <li key="/current">
        <div className="ws-row ws-row-current">
          <button
            className="ws-row-main"
            type="button"
            aria-expanded={open}
            title={`/workspace/${current}`}
            onClick={() => toggleFolder(current)}
          >
            <span className="ws-caret">
              <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
            </span>
            <span className="ws-icon">
              <Icon name="folder" size={14} />
            </span>
            <span className="ws-name">이 대화의 작업 폴더</span>
            <span className="ws-badge">현재 대화</span>
          </button>
        </div>
        {missing ? (
          <p className="ws-note muted" style={{ paddingInlineStart: "36px" }}>
            {NOTHING_MADE_YET}
          </p>
        ) : open ? (
          renderFolder(current, 1, NOTHING_MADE_YET)
        ) : null}
      </li>
    );
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
    const hiddenCount = listing.entries.length - entries.length;
    // `c` holds every conversation's folder: this conversation's is the pinned
    // row, and the others show only on request.
    if (path === "") entries = entries.filter((entry) => showOthers || entry.name !== "c");
    if (path === "c") entries = entries.filter((entry) => joinWorkspacePath(path, entry.name) !== current);
    const pinned = path === "" ? renderCurrent() : null;
    return (
      <>
        {state?.status === "error" ? (
          <p className="ws-note ws-note-error" style={{ paddingInlineStart: `${depth * 14 + 22}px` }}>
            {state.error}
          </p>
        ) : null}
        {entries.length || pinned ? (
          <ul className="ws-list">
            {pinned}
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
    const label = entryLabel(entry);
    const indent = { paddingInlineStart: `${depth * 14}px` };
    const note = !path.includes("/") && entry.kind === "dir" ? ROOT_FOLDER_NOTES[entry.name] : undefined;
    const renamed = Boolean(entry.conversation || entry.orphan);
    if (entry.kind === "dir") {
      const open = expanded.has(path);
      return (
        <li key={entry.name}>
          <div className="ws-row" style={indent}>
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
          <div className={cx("ws-row", path === marked && "ws-row-marked")} style={indent}>
            <button
              className="ws-row-main"
              type="button"
              title={`/workspace/${path}`}
              data-ws-path={path}
              aria-current={path === marked ? "true" : undefined}
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
              보기 전용 · /workspace
            </span>
          </div>
          <div className="canvas-toolbar">
            <button
              className="canvas-tool-btn"
              type="button"
              aria-pressed={showOthers}
              title="다른 대화의 작업 폴더(c)도 보기"
              onClick={() => setShowOthers((value) => !value)}
            >
              다른 대화
            </button>
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
        <p className="ws-note ws-tree-note muted">{TREE_NOTE}</p>
        {notice ? (
          <p className="ws-note ws-reveal-note" role="status" tabIndex={-1} ref={noticeRef}>
            {notice}
          </p>
        ) : null}
        <div className="canvas-content ws-tree">{renderFolder("", 0)}</div>
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
  /** A document the server is still turning into page images (`waiting`: behind other documents). */
  | { status: "converting"; waiting: boolean }
  | { status: "pages"; id: string; pages: number }
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
  const textual = !refusal && kind !== "image" && kind !== "document";
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

  // A pdf, pptx or docx: the server renders it; ask until the pages are ready.
  useEffect(() => {
    if (kind !== "document") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const ask = async (retry: boolean): Promise<void> => {
      try {
        const answer = await loadWorkspaceDocumentPreview(path, retry, controller.signal);
        if (controller.signal.aborted) return;
        if (answer.status === "ready") {
          setState({ status: "pages", id: answer.id, pages: answer.pages });
        } else if (answer.status === "failed") {
          setState({ status: "none", message: DOCUMENT_FAILURES[answer.reason] ?? DOCUMENT_FAILURES.RENDER_FAILED });
        } else if (Date.now() - started > DOCUMENT_POLL_LIMIT_MS) {
          setState({ status: "none", message: "미리보기 변환이 너무 오래 걸립니다. 다운로드해서 확인해 주세요." });
        } else {
          setState({ status: "converting", waiting: Boolean(answer.waiting) });
          timer = setTimeout(() => void ask(false), DOCUMENT_POLL_MS);
        }
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === "AbortError") return;
        setState({ status: "none", message: err instanceof Error ? err.message : "미리보기를 불러오지 못했습니다." });
      }
    };
    // 새로고침 (a re-read of the same file) also retries a conversion that failed.
    void ask(version > 0);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // One conversation with the server per mount: the parent remounts this for another file or a re-read.
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
  } else if (state.status === "converting") {
    body = (
      <p className="muted" role="status">
        {state.waiting
          ? "다른 문서를 변환하고 있어 순서를 기다리는 중입니다…"
          : "문서를 미리보기로 변환하는 중입니다. 잠시만 기다려 주세요…"}
      </p>
    );
  } else if (state.status === "pages") {
    const { id, pages } = state;
    body = (
      <>
        {Array.from({ length: pages }, (_, index) => (
          <figure className="file-preview-slide" key={index}>
            <img
              src={workspacePreviewPageUrl(id, index + 1)}
              alt={`${workspaceDisplayName(entry.name)} ${index + 1}쪽`}
              loading="lazy"
            />
            {pages > 1 ? (
              <figcaption className="muted">
                {index + 1} / {pages}
              </figcaption>
            ) : null}
          </figure>
        ))}
        {pages >= WORKSPACE_DOCUMENT_PREVIEW_MAX_PAGES ? (
          <p className="ws-note muted">
            처음 {WORKSPACE_DOCUMENT_PREVIEW_MAX_PAGES}쪽까지만 표시합니다. 전체는 다운로드해서 확인해 주세요.
          </p>
        ) : null}
        {/* LibreOffice's rendering of an office file is an approximation; a pdf's pages are the pages. */}
        {workspaceExtension(entry.name) !== "pdf" ? (
          <p className="ws-note muted">미리보기는 실제 파일과 글꼴·배치가 조금 다를 수 있습니다.</p>
        ) : null}
      </>
    );
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
