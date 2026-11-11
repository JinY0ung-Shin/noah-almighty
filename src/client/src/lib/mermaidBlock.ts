// A ```mermaid code block of rendered Markdown, drawn as the diagram it describes.
//
// The avatar writes a diagram the way a model writes one anyway — a fenced code
// block whose language is `mermaid` — and the block draws itself in place: the
// header keeps its label and copy button, gains a 소스 toggle, and the <pre>
// gives way to the diagram. There is no tool call and no side panel (that is the
// `mermaid` CANVAS, an artifact worked on with the user); nothing checks the
// source before it is on screen, so a diagram that cannot be drawn keeps showing
// its source with one line saying why, and says so to whoever listens
// (`diagramProblems`) — the chat hands it to the avatar with the next turn.
//
// Driven by lib/dom.ts, which owns the code-block wrapper: `syncMermaidBlocks`
// runs after a block's nodes are mounted, patched or re-enhanced.
// - An OPEN block (the fence is still being written) stays code: half a diagram
//   is a parse error, and a drawing that jumps per token is worse than text.
// - Everything is kept on the wrapper element, never in the html: the stream
//   renderer's "same html as a whole render" bar is untouched.
// - Results are cached by (theme, source): one answer is mounted up to three
//   times (live bubble → drain → stored message), and a cache hit draws in the
//   same task, so the diagram does not blink back to code at each handover.
import { renderMermaidSvg, MermaidLoadError } from "./mermaidRender";
import { shadowSvg } from "./shadowSvg";
import { currentTheme, theme } from "./theme";

/** Bubbles from a block whose diagram could not be drawn; `detail.problem` is one English line. */
export const DIAGRAM_ERROR_EVENT = "diagramerror";

const MERMAID_LANGUAGE = /(?:^|\s)language-mermaid(?:\s|$)/i;
const MAX_CACHED = 40;
/** A drawing larger than this is redrawn on a remount instead of being kept. */
const MAX_CACHED_SVG_CHARS = 400_000;
/**
 * Mermaid's parse errors quote the source and list every token it expected.
 * The avatar gets enough of that to place the mistake (the whole line stays
 * inside `canvasReport`'s per-line cap); the viewer gets the first line.
 */
const MAX_ERROR_CHARS = 200;
const MAX_BRIEF_CHARS = 100;

type Outcome = { svg: string } | { error: string; brief: string } | { unloaded: true };

function clipped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The svg is already sanitized (`renderMermaidSvg`); a parse error is kept too,
// so a broken diagram is not parsed again at every remount.
const cache = new Map<string, Outcome>();
const inflight = new Map<string, Promise<Outcome>>();

type Phase = "code" | "drawing" | "drawn" | "failed";

interface DiagramView {
  phase: Phase;
  /** What the block was last asked to draw. */
  source: string;
  dark: boolean;
  open: boolean;
  /** Guards an async render against a newer one. */
  token: number;
  toggle: HTMLButtonElement;
  host: HTMLElement;
  note: HTMLElement;
  noteText: HTMLElement;
  retry: HTMLButtonElement;
  shadow: ReturnType<typeof shadowSvg> | null;
}

const views = new WeakMap<HTMLElement, DiagramView>();

function cacheKey(source: string, dark: boolean): string {
  return `${dark ? "d" : "l"}\n${source}`;
}

function remember(key: string, outcome: Outcome): void {
  if ("unloaded" in outcome) return; // not a verdict on the source: try again next time
  if ("svg" in outcome && outcome.svg.length > MAX_CACHED_SVG_CHARS) return;
  cache.delete(key);
  cache.set(key, outcome);
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function startRender(key: string, source: string, dark: boolean): Promise<Outcome> {
  const job = renderMermaidSvg(source, dark)
    .then(
      (svg): Outcome => ({ svg }),
      (err): Outcome => {
        if (err instanceof MermaidLoadError) return { unloaded: true };
        const message = (err instanceof Error ? err.message : String(err ?? "")).trim();
        const detail = message.replace(/\s+/g, " ");
        if (!detail) return { error: "the source could not be parsed", brief: "" };
        const firstLine = message.split("\n")[0]!.replace(/[\s:]+$/, "");
        return { error: clipped(detail, MAX_ERROR_CHARS), brief: clipped(firstLine, MAX_BRIEF_CHARS) };
      },
    )
    .then((outcome) => {
      inflight.delete(key);
      remember(key, outcome);
      return outcome;
    });
  inflight.set(key, job);
  return job;
}

function setPhase(wrapper: HTMLElement, view: DiagramView, phase: Phase): void {
  view.phase = phase;
  wrapper.dataset.diagram = phase;
  const drawn = phase === "drawn";
  view.host.hidden = !drawn;
  view.toggle.hidden = !drawn;
  view.note.hidden = phase !== "failed";
  if (!drawn) showSource(wrapper, view, false);
}

function showSource(wrapper: HTMLElement, view: DiagramView, on: boolean): void {
  wrapper.classList.toggle("code-source-on", on);
  view.toggle.setAttribute("aria-pressed", on ? "true" : "false");
}

function build(wrapper: HTMLElement, pre: HTMLElement): DiagramView {
  const doc = wrapper.ownerDocument;

  const toggle = doc.createElement("button");
  toggle.className = "code-view";
  toggle.type = "button";
  toggle.textContent = "소스";
  toggle.title = "다이어그램 대신 Mermaid 소스 보기";
  toggle.setAttribute("aria-pressed", "false");
  toggle.hidden = true;

  const host = doc.createElement("div");
  host.className = "code-diagram";
  host.setAttribute("data-fit", "");
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", "Mermaid 다이어그램");
  host.hidden = true;

  const note = doc.createElement("div");
  note.className = "code-diagram-note";
  note.setAttribute("role", "status");
  note.hidden = true;
  const noteText = doc.createElement("span");
  const retry = doc.createElement("button");
  retry.className = "code-diagram-retry";
  retry.type = "button";
  retry.textContent = "다시 그리기";
  retry.hidden = true;
  note.append(noteText, retry);

  const view: DiagramView = {
    phase: "code",
    source: "",
    dark: false,
    open: true,
    token: 0,
    toggle,
    host,
    note,
    noteText,
    retry,
    shadow: null,
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    showSource(wrapper, view, !wrapper.classList.contains("code-source-on"));
  });
  retry.addEventListener("click", (event) => {
    event.stopPropagation();
    draw(wrapper, view);
  });

  const actions = wrapper.querySelector(":scope > .code-head > .code-actions");
  if (actions) actions.insertBefore(toggle, actions.firstChild);
  wrapper.insertBefore(host, pre);
  wrapper.insertBefore(note, pre);
  wrapper.dataset.diagram = "code";
  return view;
}

function dismantle(wrapper: HTMLElement, view: DiagramView): void {
  view.token += 1;
  view.toggle.remove();
  view.host.remove();
  view.note.remove();
  wrapper.classList.remove("code-source-on");
  delete wrapper.dataset.diagram;
  views.delete(wrapper);
}

function apply(wrapper: HTMLElement, view: DiagramView, outcome: Outcome): void {
  if ("svg" in outcome) {
    if (view.shadow) view.shadow.update(outcome.svg);
    else view.shadow = shadowSvg(view.host, outcome.svg);
    setPhase(wrapper, view, "drawn");
    return;
  }
  // The source stays on screen; a drawing of an older source must not.
  view.shadow?.update("");
  if ("unloaded" in outcome) {
    view.noteText.textContent = "다이어그램 도구를 불러오지 못해 소스를 표시합니다.";
    view.retry.hidden = false;
    setPhase(wrapper, view, "failed");
    return;
  }
  view.noteText.textContent = outcome.brief
    ? `다이어그램을 그리지 못해 소스를 표시합니다 (상세: ${outcome.brief})`
    : "다이어그램을 그리지 못해 소스를 표시합니다.";
  view.retry.hidden = true;
  setPhase(wrapper, view, "failed");
  const problem = `\`\`\`mermaid block: the diagram could not be drawn and the user sees its source instead — ${outcome.error}`;
  // After the task that mounted the block: a cached failure lands while the
  // nodes are still being put in place and the listeners attached.
  queueMicrotask(() => {
    if (!wrapper.isConnected || views.get(wrapper) !== view || view.phase !== "failed") return;
    wrapper.dispatchEvent(new CustomEvent(DIAGRAM_ERROR_EVENT, { bubbles: true, detail: { problem } }));
  });
}

function draw(wrapper: HTMLElement, view: DiagramView): void {
  const token = ++view.token;
  const key = cacheKey(view.source, view.dark);
  const hit = cache.get(key);
  if (hit) {
    apply(wrapper, view, hit);
    return;
  }
  // Until the render lands the block shows what it showed: its code, or (on a
  // theme flip) the drawing in the old palette — never an empty box.
  if (view.phase !== "drawn") setPhase(wrapper, view, "drawing");
  const job = inflight.get(key) ?? startRender(key, view.source, view.dark);
  void job.then((outcome) => {
    if (view.token !== token || views.get(wrapper) !== view) return; // a newer render won, or the block is gone
    apply(wrapper, view, outcome);
  });
}

function syncBlock(wrapper: HTMLElement, open: boolean): void {
  const pre = wrapper.querySelector<HTMLElement>(":scope > pre");
  const code = pre?.querySelector(":scope > code") ?? null;
  let view = views.get(wrapper);
  if (!pre || !code || !MERMAID_LANGUAGE.test(code.getAttribute("class") || "")) {
    // The info string was still being typed (```mer…) or the block changed.
    if (view) dismantle(wrapper, view);
    return;
  }
  if (!view) {
    view = build(wrapper, pre);
    views.set(wrapper, view);
    watchTheme();
  }
  const source = (code.textContent ?? "").trim();
  const dark = currentTheme() === "dark";
  view.open = open;
  if (open || !source) {
    view.token += 1;
    view.source = source;
    if (view.phase !== "code") setPhase(wrapper, view, "code");
    return;
  }
  if (view.phase !== "code" && view.source === source && view.dark === dark) return;
  view.source = source;
  view.dark = dark;
  draw(wrapper, view);
}

// Mermaid bakes the theme's colours into the SVG, so a flip redraws every
// diagram on the page. One subscription for all of them, made with the first.
let watching = false;
function watchTheme(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  let first = true;
  theme.subscribe(() => {
    if (first) {
      first = false;
      return;
    }
    document.querySelectorAll<HTMLElement>(".code-block[data-diagram]").forEach((wrapper) => {
      const view = views.get(wrapper);
      if (view) syncBlock(wrapper, view.open);
    });
  });
}

function eachCodeBlock(root: ParentNode | readonly Node[], visit: (wrapper: HTMLElement) => void): void {
  const scan = (node: ParentNode): void => {
    if (node instanceof HTMLElement && node.classList.contains("code-block")) visit(node);
    else node.querySelectorAll<HTMLElement>(".code-block").forEach(visit);
  };
  if (Array.isArray(root)) {
    for (const node of root as readonly Node[]) if (node.nodeType === 1) scan(node as Element);
  } else scan(root as ParentNode);
}

/**
 * Bring every ```mermaid code block under `root` (an element, or a block's own
 * nodes) up to date: `open` — still being written — keeps it as code; otherwise
 * it is drawn, once per (source, theme). Blocks of another language are left
 * alone. Call it after `enhanceRendered` wrapped the <pre>s.
 */
export function syncMermaidBlocks(root: ParentNode | readonly Node[], open = false): void {
  if (typeof document === "undefined") return;
  eachCodeBlock(root, (wrapper) => syncBlock(wrapper, open));
}

/**
 * Svelte action: hear about the diagrams under `node` that could not be drawn —
 * one ENGLISH line each, for the avatar (lib/canvasReport.ts decides whether it
 * goes anywhere). Use it on the element the Markdown is rendered into.
 */
export function diagramProblems(node: HTMLElement, handler: (problem: string) => void) {
  let current = handler;
  const listen = (event: Event): void => {
    const problem = (event as CustomEvent<{ problem?: unknown }>).detail?.problem;
    if (typeof problem === "string" && problem) current(problem);
  };
  node.addEventListener(DIAGRAM_ERROR_EVENT, listen);
  return {
    update(next: (problem: string) => void) {
      current = next;
    },
    destroy() {
      node.removeEventListener(DIAGRAM_ERROR_EVENT, listen);
    },
  };
}

/** Forget every cached drawing (tests). */
export function resetMermaidBlocks(): void {
  cache.clear();
  inflight.clear();
}
