import { useEffect, useRef, useState } from "react";
import CanvasHtmlFrame from "./CanvasHtmlFrame";
import {
  FRAMED_PAGE_SAFE_MIN_EXTENSION_VERSION,
  browserBridgeReachable,
  workspaceHtmlPageMayRun,
} from "../lib/browserBridge";
import { canvasHtmlDocument } from "../lib/canvasHtml";
import { useStore } from "../lib/hooks";
import { goView } from "../lib/nav";
import { updateState } from "../lib/state";
import { theme as themeStore } from "../lib/theme";
import { requestWorkspaceHtmlPageUrl } from "../lib/workspaceFiles";
import { WORKSPACE_HTML_PAGE_SANDBOX } from "../../../shared/workspaceFiles";

// An .html file of the workspace as a page that RUNS (the 파일 tab only; an
// `html` canvas stays the script-less CanvasHtmlFrame). The frame loads the
// file from the server's page route, never from text this app holds: a
// `srcdoc` or `blob:` document would inherit the app's own policy, under which
// no inline script runs. The route answers with a policy of its own and the
// `sandbox` here has no `allow-same-origin`, so the page is in an origin of
// its own — its scripts cannot read the session, call the API, or touch the
// app around the frame (`WORKSPACE_HTML_PAGE_CSP`, routes/workspaceFiles.ts).
//
// Two things are decided HERE before a page runs, because the page is the
// agent's and the address it is served at is Noah's:
// - the browser bridge: an extension build older than
//   FRAMED_PAGE_SAFE_MIN_EXTENSION_VERSION answers any document at a Noah
//   address, so with one installed the page is shown WITHOUT scripts (the old
//   sanitized frame) and a line says what to update. Enabling an extension
//   gives `chrome.runtime` to documents already open, a running page included,
//   so the question is asked again the moment one appears under a running page;
// - the ticket: the route serves the page for a one-use ticket only this app
//   can ask for, so nothing but this component can make a page run.
//
// The app cannot look into such a page, so the frame is not fitted to its
// content: it takes the height the panel has left and the page scrolls inside
// it — the window a deck or an app-like page lays itself out for.

/** Never shorter than this, however small the panel. */
const MIN_FRAME_HEIGHT = 240;
/** How often a running page's surroundings are looked at for an extension that was not there before. */
const BRIDGE_WATCH_MS = 1000;

type PageState =
  | { status: "checking" }
  | { status: "running"; src: string }
  /** Shown without scripts; `note` says why (and `update`: the extension is what to fix). */
  | { status: "static"; note: string; update: boolean };

export interface WorkspaceHtmlPageProps {
  path: string;
  title: string;
  /** The file's text, as the tab read it: what the script-less fallback draws. */
  text: string;
}

/** One .html file: run as a page where that is safe here, else drawn without its scripts. Remounted for a re-read. */
export default function WorkspaceHtmlPage({ path, title, text }: WorkspaceHtmlPageProps) {
  const [state, setState] = useState<PageState>({ status: "checking" });
  const resolvedTheme = useStore(themeStore);

  useEffect(() => {
    const controller = new AbortController();
    // Whether an extension could hear this address when the page was last allowed to run.
    let heard = false;
    let deciding = false;
    const decide = async (): Promise<void> => {
      deciding = true;
      try {
        heard = browserBridgeReachable();
        const verdict = await workspaceHtmlPageMayRun();
        if (controller.signal.aborted) return;
        if (!verdict.run) {
          setState({
            status: "static",
            update: true,
            note:
              verdict.reason === "outdated"
                ? `설치된 브라우저 확장${verdict.version ? `(${verdict.version})` : ""}이 오래되어 이 페이지의 스크립트는 실행하지 않았습니다. 확장을 ${FRAMED_PAGE_SAFE_MIN_EXTENSION_VERSION} 이상으로 업데이트한 뒤 새로고침을 누르면 실행됩니다.`
                : "브라우저 확장의 버전을 확인하지 못해 이 페이지의 스크립트는 실행하지 않았습니다. 잠시 뒤 새로고침을 눌러 주세요.",
          });
          return;
        }
        const src = await requestWorkspaceHtmlPageUrl(path, controller.signal);
        if (!controller.signal.aborted) setState({ status: "running", src });
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === "AbortError") return;
        setState({
          status: "static",
          update: false,
          note: "페이지를 실행하지 못해 스크립트 없이 표시합니다. 새로고침을 눌러 다시 시도할 수 있습니다.",
        });
      } finally {
        deciding = false;
      }
    };
    void decide();
    // An extension enabled or loaded AFTER the page started is heard by the
    // running page too. The moment one appears, the page comes down and the
    // question is asked again (a build that refuses the page starts it afresh).
    const watch = (): void => {
      if (!browserBridgeReachable()) {
        heard = false; // gone: its return is a new appearance
        return;
      }
      if (deciding || heard) return;
      setState({ status: "checking" });
      void decide();
    };
    const timer = setInterval(watch, BRIDGE_WATCH_MS);
    window.addEventListener("focus", watch);
    document.addEventListener("visibilitychange", watch);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", watch);
      document.removeEventListener("visibilitychange", watch);
    };
    // One watch per mount: the parent remounts this for another file or a re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.status === "checking") return <p className="muted">불러오는 중…</p>;
  if (state.status === "running") return <RunningPage src={state.src} title={title} />;
  return (
    <>
      <p className="ws-note muted" role="status">
        {state.note}{" "}
        {state.update ? (
          <button
            className="ws-note-action"
            type="button"
            onClick={() => {
              // The same one-shot deep link the composer's bridge badge uses.
              updateState((app) => {
                app.browserGuideRequested = true;
              });
              goView("settings", "access");
            }}
          >
            확장 업데이트 안내
          </button>
        ) : null}
      </p>
      <CanvasHtmlFrame doc={canvasHtmlDocument(text, resolvedTheme)} title={title} />
    </>
  );
}

function RunningPage({ src, title }: { src: string; title: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // The height the panel's scrolling body has left: its own height minus what
  // sits above the frame and what follows it (the card's padding), so the body
  // itself has nothing to scroll and only the page does. Measured in the
  // observer's callback (after layout), never during mount.
  useEffect(() => {
    const frame = frameRef.current;
    const body = frame?.closest<HTMLElement>(".canvas-body");
    if (!frame || !body) return;
    const fit = (): void => {
      if (!frame.getClientRects().length) return; // the tab is not showing
      const box = frame.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      let contentEnd = box.bottom;
      for (const child of Array.from(body.children)) {
        if (child.getClientRects().length) contentEnd = Math.max(contentEnd, child.getBoundingClientRect().bottom);
      }
      const above = box.top - bodyBox.top + body.scrollTop;
      const below = contentEnd - box.bottom + (parseFloat(getComputedStyle(body).paddingBottom) || 0);
      const height = Math.max(MIN_FRAME_HEIGHT, Math.floor(body.clientHeight - above - below));
      if (frame.style.height !== `${height}px`) frame.style.height = `${height}px`;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(body);
    // The file's header row sits above the frame in the same card and can wrap
    // to a second line (a long name, a button appearing) with no panel resize.
    const card = frame.closest<HTMLElement>(".canvas-card");
    if (card) observer.observe(card);
    return () => observer.disconnect();
  }, []);

  return (
    <iframe
      ref={frameRef}
      className="ws-html-frame"
      title={title}
      sandbox={WORKSPACE_HTML_PAGE_SANDBOX}
      referrerPolicy="no-referrer"
      src={src}
    ></iframe>
  );
}
