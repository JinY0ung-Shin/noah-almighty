import DOMPurify from "dompurify";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import CanvasHtmlFrame from "./CanvasHtmlFrame";
import Icon from "./Icon";
import { canvasHtmlDocument } from "../lib/canvasHtml";
import { confirmAction } from "../lib/confirm";
import { renderMarkdown, timeLabel } from "../lib/format";
import { cx, useAction, useLatest, useStore, useWindowEvent } from "../lib/hooks";
import { isTopDialogLayer, openModalFocus, trapTab } from "../lib/modalBehavior";
import { theme as themeStore } from "../lib/theme";
import type { ResolvedTheme } from "../lib/theme";
import {
  deleteCanvas,
  dismissCanvas,
  fetchCanvasVersions,
  rollbackCanvas,
  submitCanvas,
  submitCanvasEdit,
} from "../lib/chat";
import { queueCanvasRenderReport } from "../lib/canvasReport";
import { renderMermaidSvg } from "../lib/mermaidRender";
import { shadowSvg } from "../lib/shadowSvg";
import { copyText } from "../lib/dom";
import { copyPng, downloadPng, downloadSvg } from "../lib/canvasExport";
import { notify } from "../lib/state";
import type { ChatPane, PaneCanvas } from "../lib/types";

type CanvasControl = NonNullable<PaneCanvas["controls"]>[number];

// ONE visual-canvas artifact (#50) as a tab of the side panel (SidePanel):
// the avatar-shown content (markdown/svg/html/mermaid — all
// sanitized, never executing avatar JS) plus real form controls that post back through
// /api/chat/respond (blocking) or /api/chat/stream (async). The instance
// stays mounted while another tab shows, so its form/edit state survives a
// switch; only the card's DOM is dropped while hidden.
//
// Interactive UI is not a canvas: an avatar writes it straight into its answer
// (components/widget/AnswerUi). A `widget` canvas an older build stored shows
// its source here, with a line saying so.
export interface CanvasTabProps {
  pane: ChatPane;
  canvas: PaneCanvas;
  /** This tab is the one the panel shows. */
  active?: boolean;
}

/** What the card shows: exactly one of the three is set (or none, before the first render). */
interface Surface {
  html: string;
  svg: string;
  doc: string;
}

function controlDefaults(controls: NonNullable<PaneCanvas["controls"]>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const ctrl of controls) {
    if (ctrl.type === "buttons") next[ctrl.id] = [];
    else if (ctrl.type === "slider") next[ctrl.id] = ctrl.defaultValue ?? ctrl.min ?? 0;
    else next[ctrl.id] = ctrl.defaultValue ?? ""; // text | select | number | date
  }
  return next;
}

function errorDetail(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "no detail";
}
// Wrap a raw (English) mermaid library message in a Korean sentence,
// keeping the detail — a bare English message reads as a crash in the KO UI.
function mermaidRenderError(err: unknown): string {
  const detail = err instanceof Error ? err.message : "";
  return detail ? `mermaid 렌더링에 실패했습니다 (상세: ${detail})` : "mermaid 렌더링에 실패했습니다.";
}

// A failed render shows the source instead (escaped, so it is text).
function sourceFallback(source: string): string {
  const escaped = source.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
  return DOMPurify.sanitize(`<pre>${escaped}</pre>`);
}

function optValue(opt: { label: string; value?: string }): string {
  return opt.value ?? opt.label;
}
function renderSubmitted(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}
function controlLabel(ctrl: CanvasControl): string {
  return ctrl.label || ctrl.id;
}
function canvasDomId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}
function controlDomId(target: PaneCanvas, ctrl: CanvasControl, suffix: string): string {
  return canvasDomId(`canvas-control-${suffix}`, `${target.id}-${ctrl.id}`);
}

/** What a field shows for a stored control value: nothing for an unset one. */
function fieldValue(value: unknown): string | number {
  if (value === null || value === undefined) return "";
  return typeof value === "number" ? value : String(value);
}
/** What a numeric field (number, range) stores: its number, or null while empty. */
function numericValue(raw: string): number | null {
  return raw === "" ? null : +raw;
}

// ---- export ----
const isImageType = (c: PaneCanvas): boolean =>
  c.contentType === "svg" || c.contentType === "mermaid";

/** A surface container holds EITHER the sanitized html (markdown, a source fallback) OR one child. */
function surfaceContent(child: ReactNode, html: string): { children: ReactNode } | { dangerouslySetInnerHTML: { __html: string } } {
  return child ? { children: child } : { dangerouslySetInnerHTML: { __html: html } };
}

export default function CanvasTab({ pane, canvas, active = false }: CanvasTabProps) {
  const theme = useStore(themeStore);

  // ---- control + editor state, built once per artifact ----
  const [formCanvasId, setFormCanvasId] = useState(canvas.id);
  const [ctrlVals, setCtrlVals] = useState<Record<string, unknown>>(() => controlDefaults(canvas.controls || []));
  const [editDraft, setEditDraft] = useState(canvas.content);
  // The content the edit draft was seeded from: a draft still equal to it is
  // untouched, so a refinement may replace it.
  const [draftSeed, setDraftSeed] = useState(canvas.content);
  const [resubmitting, setResubmitting] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<{ version: number; createdAt: string }[]>([]);
  const [versionsLoading, setVersionsLoadingState] = useState(false);
  const versionsLoadingRef = useRef(false); // the same flag, for the load that asks later
  const [versionsError, setVersionsError] = useState("");
  function setVersionsLoading(value: boolean): void {
    versionsLoadingRef.current = value;
    setVersionsLoadingState(value);
  }

  // Both run while rendering (state of this component only), so the card never
  // paints a draft or a control the artifact no longer has.
  if (canvas.id !== formCanvasId) {
    setFormCanvasId(canvas.id);
    setCtrlVals(controlDefaults(canvas.controls || []));
    setEditDraft(canvas.content);
    setDraftSeed(canvas.content);
    setResubmitting(false);
    setShowVersions(false);
    setVersions([]);
    setVersionsError("");
    versionsLoadingRef.current = false;
    setVersionsLoadingState(false);
  } else {
    // A refinement in place (same canvasId) while the tab is mounted: an
    // untouched draft follows the new content (else 보내기 would send the OLD
    // version back as an edit), a draft being edited stays; new controls get
    // their defaults while a re-used control id keeps what was typed — the pptx
    // skill's review rounds rely on that.
    if (canvas.content !== draftSeed) {
      if (editDraft === draftSeed) setEditDraft(canvas.content);
      setDraftSeed(canvas.content);
    }
    const added = (canvas.controls || []).filter((ctrl) => !(ctrl.id in ctrlVals));
    if (added.length) setCtrlVals({ ...ctrlVals, ...controlDefaults(added) });
  }

  // ---- fullscreen ----
  const [fullscreen, setFullscreen] = useState(false);
  const fsRef = useRef<HTMLDivElement | null>(null);
  const fsOpener = useRef<HTMLButtonElement | null>(null); // the card's CURRENT ⤢ (re-created with the card)
  const [zoom, setZoom] = useState(1);

  // What runs LATER (an async render landing, a report about to go out, the
  // stage closing) reads the tab as it is then, not as it was when it started.
  const latest = useLatest({ pane, canvas, active, fullscreen });

  // ---- content rendering (CSP-safe: no avatar-authored JS ever runs) ----
  // ONE surface shows the canvas, and only markdown (or a source fallback) is
  // parsed into the app's own DOM: a drawing (svg/mermaid) goes into a
  // shadow root (shadowSvg) and an `html` page into its own sandboxed document
  // (CanvasHtmlFrame), so neither one's <style> can restyle the app.
  // Async renders (mermaid) set this when they land, so the previous surface
  // stays up meanwhile instead of blinking out on every theme flip.
  const [surface, setSurface] = useState<Surface>({ html: "", svg: "", doc: "" });
  function showRendered(next: { html?: string; svg?: string; doc?: string }): void {
    setSurface({ html: next.html ?? "", svg: next.svg ?? "", doc: next.doc ?? "" });
  }
  const [renderError, setRenderError] = useState("");
  // Not a failure of the content: this build cannot draw the canvas at all (an
  // unknown type), so the line reads as an instruction, not as "렌더링 실패".
  const [renderNotice, setRenderNotice] = useState("");
  // The failure was a LOAD (a lazy chunk), not the content: offer to render again.
  const [renderRetry, setRenderRetry] = useState(false);
  function retryRender(): void {
    rendered.current.content = null;
    renderIfChanged(canvas, theme);
  }
  // A render that failed in THIS browser was something only the viewer saw. The
  // reasons go to the avatar (lib/canvasReport.ts: once per content, only while
  // that content is still what this tab shows, never for a replayed older
  // version) so it can fix the canvas on its next turn. `errors` are English.
  const tabDestroyed = useRef(false);
  useEffect(() => {
    tabDestroyed.current = false;
    return () => {
      tabDestroyed.current = true;
    };
  }, []);
  // What is wrong with the content this tab last rendered. Kept so that a
  // failure found while the tab was hidden again before it could be sent (the
  // panel moved on within a moment) is offered once more when the tab shows.
  const standingProblems = useRef<{ content: string; errors: string[] } | null>(null);
  function reportRenderProblems(content: string, errors: string[]): void {
    const known = standingProblems.current?.content === content ? standingProblems.current.errors : [];
    standingProblems.current = { content, errors: [...new Set([...known, ...errors])].slice(0, 20) };
    queueRenderReport(content, errors);
  }
  function requeueStandingProblems(): void {
    const standing = standingProblems.current;
    if (standing && standing.content === latest.current.canvas.content) queueRenderReport(standing.content, standing.errors);
  }
  function queueRenderReport(content: string, errors: string[]): void {
    const canvasId = latest.current.canvas.id;
    queueCanvasRenderReport({
      canvasId,
      conversationId: latest.current.pane.conversationId,
      content,
      errors,
      stillCurrent: () => {
        const now = latest.current;
        return !tabDestroyed.current && (now.active || now.fullscreen) && now.canvas.id === canvasId && now.canvas.content === content;
      },
    });
  }
  useLayoutEffect(() => {
    if (active || fullscreen) requeueStandingProblems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fullscreen]);

  const contentRef = useRef<HTMLDivElement | null>(null); // so export can read the rendered <svg>
  // Token guards async (mermaid) renders so a stale result can't overwrite a newer one.
  const renderToken = useRef(0);

  // Rendered while the tab (or its fullscreen view) shows, and only when what
  // it shows changed: this component renders again on EVERY store write (the
  // `canvas` object is mutated in place, so it can never say whether it
  // changed), and a sanitize — or a whole mermaid render — per keystroke
  // or streamed token adds up. A hidden tab renders again when it shows. The
  // theme is a real dependency, not decoration: mermaid bakes its
  // colors into the SVG at build time, so a theme flip has to re-render or the
  // diagram stays on the old palette.
  const rendered = useRef<{ type: string; content: string | null; theme: string }>({ type: "", content: null, theme: "" });
  function renderIfChanged(target: PaneCanvas, resolvedTheme: ResolvedTheme): void {
    const last = rendered.current;
    if (target.contentType === last.type && target.content === last.content && resolvedTheme === last.theme) return;
    rendered.current = { type: target.contentType, content: target.content, theme: resolvedTheme };
    void renderCanvas(target, resolvedTheme);
  }
  // Before paint, like the form above: a canvas that just arrived (or a tab
  // that just showed) is drawn in the same frame as its card.
  useLayoutEffect(() => {
    if (active || fullscreen) renderIfChanged(canvas, theme);
  });

  async function renderCanvas(target: PaneCanvas, resolvedTheme: ResolvedTheme): Promise<void> {
    const token = ++renderToken.current;
    setRenderError("");
    setRenderNotice("");
    setRenderRetry(false);
    standingProblems.current = null;
    if (target.contentType === "markdown") {
      showRendered({ html: renderMarkdown(target.content) });
      return;
    }
    if (target.contentType === "svg") {
      showRendered({ svg: DOMPurify.sanitize(target.content, { USE_PROFILES: { svg: true, svgFilters: true } }) });
      return;
    }
    if (target.contentType === "html") {
      showRendered({ doc: canvasHtmlDocument(target.content, resolvedTheme) });
      return;
    }
    if (target.contentType === "vega") {
      // RETIRED 2026-11-12 (a canvas an older build stored): the app no longer
      // carries a Vega renderer, so only the spec's source is shown. A chart is
      // an inline <chart> of the answer now; `mcp__canvas__show` refuses 'vega'.
      setRenderNotice("더 이상 지원하지 않는 Vega 차트 형식의 캔버스입니다. 원본만 표시합니다.");
      showRendered({ html: sourceFallback(target.content) });
      return;
    }
    if ((target.contentType as string) === "widget") {
      // The retired canvas `widget` type (a row an older build stored): interactive
      // UI is written in the answer itself now, so only its source is shown.
      setRenderNotice("더 이상 지원하지 않는 위젯 형식의 캔버스입니다. 원본만 표시합니다.");
      showRendered({ html: sourceFallback(target.content) });
      return;
    }
    if (target.contentType === "mermaid") {
      try {
        // The same renderer a ```mermaid block of an answer uses (lib/mermaidRender.ts).
        const svg = await renderMermaidSvg(target.content, resolvedTheme === "dark");
        if (token !== renderToken.current) return; // a newer render won
        showRendered({ svg });
      } catch (err) {
        if (token !== renderToken.current) return;
        setRenderError(mermaidRenderError(err));
        showRendered({ html: sourceFallback(target.content) });
        reportRenderProblems(target.content, [`the mermaid diagram did not render: ${errorDetail(err)}`]);
      }
      return;
    }
    // A type this build does not know: a tab loaded before a deploy that added
    // one. Drawing nothing looked like an empty canvas; say what to do and show
    // the source meanwhile. (Not the avatar's mistake, so nothing is reported.)
    setRenderNotice("이 캔버스를 표시하려면 페이지를 새로고침해 주세요.");
    showRendered({ html: sourceFallback(target.content) });
  }

  // The drawing's host in the card and the one in the fullscreen view: each
  // draws the same sanitized markup into its own shadow root.
  const panelSvgRef = useAction<HTMLDivElement, string>(shadowSvg, surface.svg);
  const stageSvgRef = useAction<HTMLDivElement, string>(shadowSvg, surface.svg);

  // ---- form controls ----
  function setControl(ctrlId: string, value: unknown): void {
    setCtrlVals((current) => ({ ...current, [ctrlId]: value }));
  }
  function toggleButton(ctrlId: string, value: string, multi: boolean): void {
    setCtrlVals((vals) => {
      const current = Array.isArray(vals[ctrlId]) ? (vals[ctrlId] as string[]) : [];
      const next = multi
        ? current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value]
        : [value];
      return { ...vals, [ctrlId]: next };
    });
  }
  function isSelected(ctrlId: string, value: string): boolean {
    return Array.isArray(ctrlVals[ctrlId]) && (ctrlVals[ctrlId] as string[]).includes(value);
  }

  const canSubmit =
    Boolean(canvas.controls?.length) &&
    (canvas.controls || []).every((ctrl) => {
      if (ctrl.required === false) return true;
      const v = ctrlVals[ctrl.id];
      if (ctrl.type === "buttons") return Array.isArray(v) && v.length > 0;
      if (ctrl.type === "slider") return true; // always carries a value
      if (ctrl.type === "number") {
        if (v === "" || v === null || v === undefined) return false;
        const n = Number(v);
        if (Number.isNaN(n)) return false;
        if (typeof ctrl.min === "number" && n < ctrl.min) return false;
        if (typeof ctrl.max === "number" && n > ctrl.max) return false;
        return true;
      }
      return String(v ?? "").trim().length > 0; // text | select | date
    });

  // The controls form is shown for a blocking pending canvas, an async canvas, or a
  // re-submission of an already-answered async canvas.
  const showForm = Boolean(
    canvas.controls?.length &&
      (canvas.pending || (canvas.interaction === "async" && (!canvas.submittedValues || resubmitting))),
  );
  // The run is PARKED on this canvas (blocking ask): the answer posts to
  // /api/chat/respond MID-run — the run resumes only after the user submits or
  // skips — so `pane.streaming` must NOT lock the form here. Locking it
  // deadlocks the question: the run waits for the user, the form waits for the
  // run (regression 8aed88d→208489d; the run stays `streaming` while parked).
  const awaitingAnswer = Boolean(canvas.pending && canvas.requestId && canvas.runId);
  const controlsLocked = Boolean(canvas.submitting || (pane.streaming && !awaitingAnswer));
  // Content edits always ride a NEW chat turn (submitCanvasEdit → sendMessage),
  // so the edit path DOES wait for the avatar's turn to end — even while parked.
  const editLocked = Boolean(canvas.submitting || pane.streaming);
  const editTrimmed = editDraft.trim();
  const editDirty = editDraft !== canvas.content;
  const editCanSubmit = Boolean(canvas.editable && editTrimmed && editDirty && !editLocked);
  const editStatus = editLocked
    ? "아바타 응답이 끝난 뒤 수정할 수 있습니다."
    : !editTrimmed
      ? "수정할 내용을 입력하세요."
      : !editDirty
        ? "원본과 같은 내용입니다."
        : "수정본을 보낼 준비가 됐습니다.";
  const controlsStatusId = canvasDomId("canvas-controls-status", canvas.id);
  const controlsStatus = canvas.submitting
    ? "응답을 보내는 중입니다."
    : controlsLocked
      ? "아바타 응답이 끝난 뒤 보낼 수 있습니다."
      : canSubmit
        ? "보낼 준비가 됐습니다."
        : "필수 항목을 입력해 주세요.";
  // The skip button only makes sense for a blocking, parked run.
  const canSkip = awaitingAnswer;
  const versionListId = canvasDomId("canvas-versions", canvas.id);
  const editLabelId = canvasDomId("canvas-edit-label", canvas.id);
  const editStatusId = canvasDomId("canvas-edit-status", canvas.id);

  function onSubmit(): void {
    if (controlsLocked || !canSubmit) return;
    const values: Record<string, unknown> = {};
    for (const ctrl of canvas.controls || []) {
      const v = ctrlVals[ctrl.id];
      if (ctrl.type === "buttons") {
        const sel = Array.isArray(v) ? (v as string[]) : [];
        values[ctrl.id] = ctrl.multiSelect ? sel : sel[0] ?? "";
      } else if (ctrl.type === "slider" || ctrl.type === "number") {
        values[ctrl.id] = v === "" || v === null || v === undefined ? "" : Number(v);
      } else {
        values[ctrl.id] = String(v ?? "").trim();
      }
    }
    setResubmitting(false);
    void submitCanvas(pane.id, canvas.id, values);
  }

  function submitEdit(): void {
    if (!editCanSubmit) return;
    // Sent, so no longer an edit in progress: the avatar's next version of
    // this canvas replaces it (else 보내기 would re-send it over that version).
    setDraftSeed(editDraft);
    void submitCanvasEdit(pane.id, canvas.id, editDraft);
  }

  function getSvgEl(): SVGSVGElement | null {
    // The drawing sits in the panel host's shadow root (shadowSvg).
    const host = contentRef.current?.querySelector(".canvas-svg");
    return (host?.shadowRoot?.querySelector("svg") as SVGSVGElement | null) ?? null;
  }
  async function onCopy(event: ReactMouseEvent<HTMLButtonElement>): Promise<void> {
    const btn = event.currentTarget;
    if (isImageType(canvas)) {
      const svg = getSvgEl();
      if (svg && (await copyPng(svg))) {
        notify("이미지를 클립보드에 복사했습니다.", "info");
        return;
      }
    }
    await copyText(latest.current.canvas.content, btn); // source text (markdown/html, or image fallback)
  }
  function onDownloadPng(): void {
    const svg = getSvgEl();
    if (svg) void downloadPng(svg, canvas.title);
    else notify("이 캔버스는 PNG로 저장할 수 없습니다.", "warn");
  }
  function onDownloadSvg(): void {
    const svg = getSvgEl();
    if (svg) downloadSvg(svg, canvas.title);
  }

  // ---- delete ----
  // Deleting is permanent (the artifact and its whole version history), so it
  // is its own confirmed action — never the × that closes a file tab.
  async function onDelete(): Promise<void> {
    const parked = awaitingAnswer ? " 응답을 기다리던 질문도 함께 취소됩니다." : "";
    const confirmed = await confirmAction(
      `"${canvas.title}" 캔버스를 삭제합니다. 버전 기록까지 모두 지워지며 되돌릴 수 없습니다.${parked}`,
      { title: "캔버스를 삭제할까요?", confirmLabel: "삭제", tone: "danger" },
    );
    if (!confirmed) return;
    await deleteCanvas(latest.current.pane.id, latest.current.canvas.id);
  }

  // ---- version history ----
  async function loadVersions(): Promise<void> {
    if (versionsLoadingRef.current) return;
    setVersionsLoading(true);
    setVersionsError("");
    try {
      setVersions(await fetchCanvasVersions(latest.current.canvas.id));
    } catch (err) {
      setVersionsError((err as Error).message || "버전 기록을 불러오지 못했습니다.");
    } finally {
      setVersionsLoading(false);
    }
  }

  async function toggleVersions(): Promise<void> {
    const next = !showVersions;
    setShowVersions(next);
    if (next) await loadVersions();
  }
  function doRollback(version: number): void {
    if (version === canvas.currentVersion) return;
    setShowVersions(false);
    void rollbackCanvas(pane.id, canvas.id, version);
  }

  function openFullscreen(): void {
    setZoom(1);
    setFullscreen(true);
  }
  function onFsKey(event: KeyboardEvent): void {
    if (event.key === "Escape") setFullscreen(false);
    else if (event.key === "Tab") trapTab(event, fsRef.current);
  }
  function onFsWheel(event: WheelEvent): void {
    event.preventDefault();
    setZoom((current) => Math.min(4, Math.max(0.4, current + (event.deltaY < 0 ? 0.15 : -0.15))));
  }

  useWindowEvent("keydown", (event) => {
    // A dialog opened over the stage takes Escape and Tab first.
    if (fullscreen && isTopDialogLayer(fsRef.current)) onFsKey(event);
  });

  // The stage lives under <body>: inside the side panel — whose backdrop-filter
  // is the containing block of fixed descendants — "fullscreen" covered only
  // the panel, and a hidden tab's tabpanel would hide it outright. It claims
  // aria-modal, so it owes the matching behavior: contain Tab, inert the page
  // behind it, and hand focus back to the opener on close. A tab the avatar
  // shows meanwhile does NOT close it (the viewer picked this view), but it
  // takes this tab's card — ⤢ included — out of the DOM: when the restore misses,
  // focus lands on this card's new ⤢ if the tab shows again, else on the tab
  // the panel shows — never on <body>.
  useLayoutEffect(() => {
    if (!fullscreen) return;
    const node = fsRef.current;
    if (!node) return;
    const releaseFocus = openModalFocus(node);
    // Zooming must stop the page behind from scrolling: a listener that may
    // preventDefault, which a React `onWheel` (passive) is not.
    const onWheel = (event: WheelEvent): void => onFsWheel(event);
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
      releaseFocus();
      // On close React has taken the stage out of <body> by now, and focus left
      // with it. When the whole tab goes away the stage is still attached here:
      // let go of the focus it holds, as its removal is about to.
      const focused = document.activeElement;
      if (node.isConnected && focused instanceof HTMLElement && node.contains(focused)) focused.blur();
      if (document.activeElement && document.activeElement !== document.body) return;
      if (latest.current.active && fsOpener.current?.isConnected) fsOpener.current.focus();
      else document.querySelector<HTMLElement>('.canvas-panel [role="tab"][aria-selected="true"]')?.focus();
    };
    // `latest` and the refs are stable; the stage exists exactly while `fullscreen`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  const hasControls = Boolean(canvas.controls?.length);

  const card = active ? (
    <div className="canvas-card">
      <div className="canvas-card-top">
        <div className="canvas-title">{canvas.title}</div>
        <div className="canvas-toolbar">
          {(canvas.versionCount || 1) > 1 ? (
            <button
              className="canvas-tool-btn"
              type="button"
              title="버전 기록"
              aria-expanded={showVersions}
              aria-controls={versionListId}
              onClick={() => void toggleVersions()}
            >
              v{canvas.currentVersion ?? 1} ▾
            </button>
          ) : null}
          <button className="canvas-tool-btn" type="button" title="복사" onClick={(event) => void onCopy(event)}>
            복사
          </button>
          {isImageType(canvas) ? (
            <>
              <button className="canvas-tool-btn" type="button" title="PNG로 저장" onClick={onDownloadPng}>
                PNG
              </button>
              <button className="canvas-tool-btn" type="button" title="SVG로 저장" onClick={onDownloadSvg}>
                SVG
              </button>
            </>
          ) : null}
          <button
            ref={fsOpener}
            className="canvas-tool-btn"
            type="button"
            title="전체화면"
            aria-label="전체화면"
            onClick={openFullscreen}
          >
            ⤢
          </button>
          <button
            className="canvas-tool-btn canvas-tool-danger"
            type="button"
            title="캔버스 삭제"
            aria-label="캔버스 삭제"
            onClick={() => void onDelete()}
          >
            <Icon name="trash" size={12} />
          </button>
        </div>
      </div>

      {showVersions ? (
        <div id={versionListId} className="canvas-versions" role="listbox" aria-label="버전 기록">
          {versionsLoading ? (
            <div className="canvas-version-state" role="status">
              버전 기록을 불러오는 중…
            </div>
          ) : versionsError ? (
            <div className="canvas-version-state error-note" role="alert">
              {versionsError}{" "}
              <button className="linkish small" type="button" onClick={() => void loadVersions()}>
                다시 시도
              </button>
            </div>
          ) : (
            versions.map((v) => (
              <button
                key={v.version}
                className={cx("canvas-version-row", v.version === canvas.currentVersion && "current")}
                type="button"
                role="option"
                aria-selected={v.version === canvas.currentVersion ? "true" : "false"}
                disabled={v.version === canvas.currentVersion}
                onClick={() => doRollback(v.version)}
              >
                <span>v{v.version}</span> <span className="canvas-version-time">{timeLabel(v.createdAt)}</span>{" "}
                {v.version === canvas.currentVersion ? (
                  <span className="canvas-version-action">현재</span>
                ) : (
                  <span className="canvas-version-action">되돌리기</span>
                )}
              </button>
            ))
          )}
        </div>
      ) : null}

      <div
        className="canvas-content md"
        ref={contentRef}
        {...surfaceContent(
          surface.doc ? (
            <CanvasHtmlFrame doc={surface.doc} title={canvas.title} />
          ) : surface.svg ? (
            <div className="canvas-svg" data-fit="" ref={panelSvgRef}></div>
          ) : null,
          surface.html,
        )}
      />
      {renderNotice ? (
        <p className="canvas-render-error" role="alert">
          {renderNotice}
        </p>
      ) : null}
      {renderError ? (
        <p className="canvas-render-error" role="alert">
          렌더링 실패: {renderError}{" "}
          {renderRetry ? (
            <button className="linkish small" type="button" onClick={retryRender}>
              다시 시도
            </button>
          ) : null}
        </p>
      ) : null}

      {canvas.editable ? (
        <div className="canvas-edit">
          <div className="canvas-control-label" id={editLabelId}>
            내용 편집
          </div>
          <div className="field">
            <textarea
              rows={5}
              value={editDraft}
              onChange={(event) => setEditDraft(event.currentTarget.value)}
              placeholder="내용을 수정해 아바타에게 보내세요"
              aria-labelledby={editLabelId}
              aria-describedby={editStatusId}
              disabled={editLocked}
            ></textarea>
          </div>
          <div id={editStatusId} className={cx("canvas-edit-status", editCanSubmit && "dirty")} role="status">
            {editStatus}
          </div>
          <div className="canvas-actions">
            <button
              className="btn btn-primary btn-sm"
              type="button"
              aria-describedby={editStatusId}
              disabled={!editCanSubmit}
              onClick={submitEdit}
            >
              수정해서 보내기
            </button>
          </div>
        </div>
      ) : null}

      {hasControls ? (
        canvas.submittedValues && !resubmitting ? (
          <div className="canvas-answered" role="status">
            <span className="canvas-answered-badge">응답 완료</span>
            <ul>
              {(canvas.controls || []).map((ctrl) => (
                <li key={ctrl.id}>
                  <strong>{ctrl.label || ctrl.id}:</strong> {renderSubmitted(canvas.submittedValues?.[ctrl.id])}
                </li>
              ))}
            </ul>
            {canvas.interaction === "async" ? (
              <button className="btn btn-ghost btn-sm" type="button" disabled={pane.streaming} onClick={() => setResubmitting(true)}>
                다시 보내기
              </button>
            ) : null}
          </div>
        ) : showForm ? (
          <form
            className="canvas-controls"
            aria-busy={canvas.submitting ? "true" : "false"}
            aria-describedby={controlsStatusId}
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            {(canvas.controls || []).map((ctrl) => {
              const labelId = controlDomId(canvas, ctrl, "label");
              // One naming for every kind of field: the visible label when there is one.
              const naming = {
                "aria-labelledby": ctrl.label ? labelId : undefined,
                "aria-label": !ctrl.label ? controlLabel(ctrl) : undefined,
                "aria-describedby": controlsStatusId,
              };
              return (
                <div className="canvas-control" key={ctrl.id}>
                  {ctrl.label ? (
                    <div id={labelId} className="canvas-control-label">
                      {ctrl.label}
                      {ctrl.required === false ? <span className="canvas-optional">(선택)</span> : null}
                    </div>
                  ) : null}
                  {ctrl.type === "buttons" ? (
                    <div className="canvas-options" role="group" {...naming}>
                      {(ctrl.options || []).map((opt, index) => (
                        <button
                          key={index}
                          type="button"
                          className={cx("canvas-opt", isSelected(ctrl.id, optValue(opt)) && "selected")}
                          aria-pressed={isSelected(ctrl.id, optValue(opt))}
                          aria-describedby={controlsStatusId}
                          disabled={controlsLocked}
                          onClick={() => toggleButton(ctrl.id, optValue(opt), Boolean(ctrl.multiSelect))}
                        >
                          <span className="canvas-opt-label">{opt.label}</span>{" "}
                          {opt.description ? <span className="canvas-opt-desc">{opt.description}</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : ctrl.type === "select" ? (
                    <div className="field">
                      <select
                        value={fieldValue(ctrlVals[ctrl.id])}
                        onChange={(event) => setControl(ctrl.id, event.currentTarget.value)}
                        {...naming}
                        disabled={controlsLocked}
                      >
                        <option value="" disabled>
                          {ctrl.placeholder || "선택하세요"}
                        </option>
                        {(ctrl.options || []).map((opt, index) => (
                          <option key={index} value={optValue(opt)}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : ctrl.type === "slider" ? (
                    <div className="canvas-slider">
                      <input
                        type="range"
                        min={ctrl.min ?? 0}
                        max={ctrl.max ?? 100}
                        step={ctrl.step ?? 1}
                        value={fieldValue(ctrlVals[ctrl.id])}
                        onChange={(event) => setControl(ctrl.id, numericValue(event.currentTarget.value))}
                        {...naming}
                        disabled={controlsLocked}
                      />
                      <span className="canvas-slider-val">{fieldValue(ctrlVals[ctrl.id])}</span>
                    </div>
                  ) : ctrl.type === "number" ? (
                    <div className="field">
                      <input
                        type="number"
                        min={ctrl.min}
                        max={ctrl.max}
                        step={ctrl.step ?? 1}
                        placeholder={ctrl.placeholder || ""}
                        value={fieldValue(ctrlVals[ctrl.id])}
                        onChange={(event) => setControl(ctrl.id, numericValue(event.currentTarget.value))}
                        {...naming}
                        disabled={controlsLocked}
                      />
                    </div>
                  ) : ctrl.type === "date" ? (
                    <div className="field">
                      <input
                        type="date"
                        value={fieldValue(ctrlVals[ctrl.id])}
                        onChange={(event) => setControl(ctrl.id, event.currentTarget.value)}
                        {...naming}
                        disabled={controlsLocked}
                      />
                    </div>
                  ) : (
                    <div className="field">
                      {ctrl.multiline ? (
                        <textarea
                          rows={3}
                          placeholder={ctrl.placeholder || ""}
                          value={fieldValue(ctrlVals[ctrl.id])}
                          onChange={(event) => setControl(ctrl.id, event.currentTarget.value)}
                          {...naming}
                          disabled={controlsLocked}
                        ></textarea>
                      ) : (
                        <input
                          type="text"
                          placeholder={ctrl.placeholder || ""}
                          value={fieldValue(ctrlVals[ctrl.id])}
                          onChange={(event) => setControl(ctrl.id, event.currentTarget.value)}
                          {...naming}
                          disabled={controlsLocked}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div
              id={controlsStatusId}
              className={cx("canvas-edit-status", (canSubmit || controlsLocked) && "dirty")}
              role="status"
              aria-live="polite"
            >
              {controlsStatus}
            </div>
            <div className="canvas-actions">
              {canSkip ? (
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  aria-describedby={controlsStatusId}
                  disabled={controlsLocked}
                  onClick={() => void dismissCanvas(pane.id, canvas.id)}
                >
                  건너뛰기
                </button>
              ) : resubmitting ? (
                <button className="btn btn-ghost btn-sm" type="button" aria-describedby={controlsStatusId} onClick={() => setResubmitting(false)}>
                  취소
                </button>
              ) : null}
              <button className="btn btn-primary btn-sm" type="submit" aria-describedby={controlsStatusId} disabled={!canSubmit || controlsLocked}>
                보내기
              </button>
            </div>
          </form>
        ) : null
      ) : canvas.submittedValues ? (
        // Values sent on a canvas that declares no controls (a retired `widget`
        // canvas's <submit>): listed by key.
        <div className="canvas-answered" role="status">
          <span className="canvas-answered-badge">응답 완료</span>
          <ul>
            {Object.entries(canvas.submittedValues).map(([key, value]) => (
              <li key={key}>
                <strong>{key}:</strong> {renderSubmitted(value)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  ) : null;

  const stage = fullscreen
    ? createPortal(
        <div ref={fsRef} className="canvas-fs" role="dialog" aria-modal="true" aria-label="캔버스 전체화면">
          <div className="canvas-fs-bar">
            <span className="canvas-fs-title">{canvas.title}</span>
            <div className="canvas-fs-zoom">
              <button className="canvas-tool-btn" type="button" aria-label="축소" onClick={() => setZoom((current) => Math.max(0.4, current - 0.2))}>
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button className="canvas-tool-btn" type="button" aria-label="확대" onClick={() => setZoom((current) => Math.min(4, current + 0.2))}>
                +
              </button>
              <button className="canvas-tool-btn" type="button" data-modal-autofocus="" onClick={() => setFullscreen(false)}>
                닫기
              </button>
            </div>
          </div>
          <button className="canvas-fs-backdrop" type="button" aria-label="닫기" onClick={() => setFullscreen(false)}></button>
          <div className="canvas-fs-stage">
            <div
              className={cx("canvas-fs-content md", surface.doc !== "" && "is-html")}
              style={{ transform: `scale(${zoom})` }}
              {...surfaceContent(
                surface.doc ? (
                  <CanvasHtmlFrame doc={surface.doc} title={canvas.title} onWheel={onFsWheel} onKeydown={onFsKey} />
                ) : surface.svg ? (
                  <div className="canvas-svg" ref={stageSvgRef}></div>
                ) : null,
                surface.html,
              )}
            />
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {card}
      {stage}
    </>
  );
}
