// DOM helpers ported from the old core.js: clipboard copy with button flash,
// and a Svelte action that enhances rendered markdown (code-block copy buttons +
// horizontally-scrollable tables) the way enhanceCodeBlocks() used to.

import { iconSvg } from "./icons";

// Built from the shared icon map so these imperative copies can't drift from
// what <Icon name="copy" /> renders elsewhere.
const COPY_SVG = iconSvg("copy", 16);
const CHECK_SVG = iconSvg("check", 16);

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Downscale an image file to a `maxDim` long edge via canvas, returning a data URL.
// The Image is loaded from a `data:` URL (FileReader), NOT `URL.createObjectURL`:
// a `blob:` URL is blocked by the production CSP (`img-src 'self' data:`), which
// would make the load fail. Output type defaults to the file's family (jpeg/webp/png
// ternary) unless `outputType` forces it; default quality 0.9.
export async function downscaleImageToDataUrl(
  file: File,
  maxDim: number,
  opts?: { quality?: number; outputType?: string },
): Promise<string> {
  const quality = opts?.quality ?? 0.9;
  const sourceDataUrl = await readFileAsDataUrl(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no 2d context"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const out =
        opts?.outputType ??
        (file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/webp" ? "image/webp" : "image/png");
      resolve(canvas.toDataURL(out, quality));
    };
    img.onerror = () => reject(new Error("image load failed"));
    img.src = sourceDataUrl;
  });
}

// First image file in a clipboard: prefer items (covers screenshots/copied
// images), fall back to files (some browsers only populate one of the two for
// a pasted image). Used by the profile photo Ctrl+V handler; ChatView's
// multi-file composer paste stays separate.
export function pastedImageFile(clipboard: DataTransfer | null): File | null {
  if (!clipboard) return null;
  const fromItems = Array.from(clipboard.items || [])
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => Boolean(f));
  const fromFiles = Array.from(clipboard.files || []).filter((f) => f.type.startsWith("image/"));
  return fromItems[0] ?? fromFiles[0] ?? null;
}

/**
 * Copy `text`. Resolves to whether it actually reached the clipboard, and
 * flashes `btn` with the same outcome — so a caller with no button can still
 * tell the user the truth.
 *
 * The async clipboard is tried first; when it is missing (http://, an old
 * WebView) OR THROWS (permission denied, the document lost focus, a policy
 * blocking it) the selection-based copy takes over. Only when both fail is the
 * copy reported as failed.
 */
export async function copyText(text: string, btn?: HTMLButtonElement | null): Promise<boolean> {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) ok = selectAndCopy(text, btn);
  if (ok) flashCopied(btn);
  else flashCopyFailed(btn);
  return ok;
}

/** A dialog that takes focus for itself: a textarea outside it cannot be focused or selected. */
const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog[open]';
const MODAL_SELECTOR = '[aria-modal="true"], dialog[open]';

function copyHost(origin: Element | null | undefined, active: Element | null): HTMLElement {
  const near = origin?.closest<HTMLElement>(DIALOG_SELECTOR) ?? active?.closest<HTMLElement>(DIALOG_SELECTOR);
  if (near) return near;
  // No hint from the button or the focus: the top-most open modal (DOM order is
  // the stacking order — see App.svelte) traps focus all the same.
  const modals = document.querySelectorAll<HTMLElement>(MODAL_SELECTOR);
  return modals.length ? modals[modals.length - 1] : document.body;
}

/**
 * `document.execCommand("copy")` on a throwaway textarea — deprecated, and the
 * only route outside a secure context or once the async clipboard refused. The
 * page is put back as it was: the textarea is removed, and the viewer's own
 * selection and focus are restored.
 */
function selectAndCopy(text: string, origin?: Element | null): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const ranges: Range[] = [];
  if (selection) for (let i = 0; i < selection.rangeCount; i += 1) ranges.push(selection.getRangeAt(i));
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.readOnly = true;
  ta.setAttribute("aria-hidden", "true");
  ta.tabIndex = -1;
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.padding = "0";
  ta.style.border = "0";
  ta.style.opacity = "0";
  ta.style.pointerEvents = "none";
  copyHost(origin, active).append(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand("copy") === true;
  } catch {
    ok = false;
  } finally {
    ta.remove();
    // Focus first: moving focus may itself move the selection.
    if (active && active !== document.activeElement) active.focus({ preventScroll: true });
    if (selection) {
      try {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      } catch {
        /* a range whose nodes left the document cannot be restored */
      }
    }
  }
  return ok;
}

// A copy flash borrows the button's content, accessible name and tooltip for
// 1.2 s. The button's OWN state is saved once per flash window — a second copy
// inside the window must not save the flash itself (the check icon, "복사됨")
// as the state to return to — and restored EXACTLY: an attribute the button
// never had is removed again, not left as "복사됨" (a button named by its
// text alone would keep that name for good) or as an empty tooltip.
interface CopyFlash {
  html: string;
  label: string | null;
  title: string | null;
  timer: number;
}
const copyFlashes = new WeakMap<HTMLButtonElement, CopyFlash>();

function flashCopied(btn?: HTMLButtonElement | null): void {
  flashCopy(btn, "copied", "복사됨");
}

function flashCopyFailed(btn?: HTMLButtonElement | null): void {
  flashCopy(btn, "copy-failed", "복사 실패");
}

function flashCopy(btn: HTMLButtonElement | null | undefined, state: "copied" | "copy-failed", text: string): void {
  if (!btn) return;
  let saved = copyFlashes.get(btn);
  if (saved) window.clearTimeout(saved.timer);
  else {
    saved = { html: btn.innerHTML, label: btn.getAttribute("aria-label"), title: btn.getAttribute("title"), timer: 0 };
    copyFlashes.set(btn, saved);
  }
  btn.classList.remove("copied", "copy-failed");
  btn.classList.add(state);
  btn.setAttribute("aria-label", text);
  btn.setAttribute("title", text);
  // Success shows the check icon; a failure keeps the button's own content
  // (and takes it back from a success still on screen).
  const html = state === "copied" ? CHECK_SVG : saved.html;
  if (btn.innerHTML !== html) btn.innerHTML = html;
  saved.timer = window.setTimeout(() => endCopyFlash(btn), 1200);
}

function endCopyFlash(btn: HTMLButtonElement): void {
  const saved = copyFlashes.get(btn);
  if (!saved) return;
  copyFlashes.delete(btn);
  btn.classList.remove("copied", "copy-failed");
  if (btn.innerHTML !== saved.html) btn.innerHTML = saved.html;
  restoreAttribute(btn, "aria-label", saved.label);
  restoreAttribute(btn, "title", saved.title);
}

function restoreAttribute(el: Element, name: string, value: string | null): void {
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

// Auto-grow a textarea with its content, capped at min(200px, 30% viewport) —
// mirrors the old composer autoGrow().
// The `_value` param mirrors the textarea's bound value so Svelte calls
// `update()` on programmatic value changes too — e.g. clearing the draft to ""
// after a send must shrink the box back, and no `input` event fires for a
// programmatic value change. CAUTION: Svelte runs an action's `update()` BEFORE
// it flushes the new `value` to the DOM node, so reading `scrollHeight` here
// synchronously sees the OLD content and re-pins the old height. Defer the
// param-driven grow to a microtask so it measures the post-flush value. The
// `input` path stays synchronous (the browser updates `value` before `input`).
export function autosize(node: HTMLTextAreaElement, _value?: string) {
  const grow = () => {
    node.style.height = "auto";
    const cap = Math.min(200, Math.round(window.innerHeight * 0.3));
    node.style.height = `${Math.min(node.scrollHeight, cap)}px`;
  };
  grow();
  node.addEventListener("input", grow);
  return {
    update() {
      queueMicrotask(grow);
    },
    destroy() {
      node.removeEventListener("input", grow);
    },
  };
}

// Close a lightweight popover/panel when the user interacts anywhere outside it.
// `onOutside` fires on a document pointerdown whose target is neither inside the
// node nor matching the `ignore` selector (the toggle button that opened it —
// excluded so its own click handler does the toggle instead of double-firing).
// Used for the composer's MCP-tool panel. Because the panel
// mounts only once it's open, the opening click's pointerdown has already
// finished before the listener attaches, so it can't immediately self-close.
export function clickOutside(
  node: HTMLElement,
  params: { onOutside: () => void; ignore?: string },
) {
  let { onOutside, ignore } = params;
  const handle = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (!target || node.contains(target)) return;
    if (ignore && target.closest(ignore)) return;
    onOutside();
  };
  document.addEventListener("pointerdown", handle, true);
  return {
    update(next: { onOutside: () => void; ignore?: string }) {
      onOutside = next.onOutside;
      ignore = next.ignore;
    },
    destroy() {
      document.removeEventListener("pointerdown", handle, true);
    },
  };
}

/* ---------- rendered markdown: code blocks, tables, live blocks ---------- */

/** Display names for a fence's info string; anything else shows as written. */
const CODE_LANGUAGE_LABELS: Record<string, string> = {
  js: "JavaScript", javascript: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JSX",
  ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", py: "Python", python: "Python",
  sh: "Shell", shell: "Shell", bash: "Bash", zsh: "Zsh", ps1: "PowerShell", powershell: "PowerShell",
  bat: "Batch", cmd: "Batch", json: "JSON", jsonc: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
  xml: "XML", html: "HTML", css: "CSS", scss: "SCSS", svelte: "Svelte", vue: "Vue", sql: "SQL",
  go: "Go", rs: "Rust", rust: "Rust", java: "Java", kt: "Kotlin", kotlin: "Kotlin", swift: "Swift",
  c: "C", h: "C", cpp: "C++", "c++": "C++", cs: "C#", csharp: "C#", php: "PHP", rb: "Ruby", ruby: "Ruby",
  md: "Markdown", markdown: "Markdown", diff: "Diff", dockerfile: "Dockerfile", docker: "Dockerfile",
  ini: "INI", env: "Env", txt: "텍스트", text: "텍스트", plaintext: "텍스트", mermaid: "Mermaid",
};
const CODE_LABEL_FALLBACK = "코드";
const CODE_LABEL_MAX = 24;

/** The fence's language, from the `language-…` class marked puts on `<code>`. */
function codeLanguageLabel(pre: Element): string {
  const code = pre.querySelector("code");
  const lang = /(?:^|\s)language-(\S+)/.exec(code?.getAttribute("class") || "")?.[1] ?? "";
  if (!lang) return CODE_LABEL_FALLBACK;
  const known = CODE_LANGUAGE_LABELS[lang.toLowerCase()];
  if (known) return known;
  return lang.length > CODE_LABEL_MAX ? `${lang.slice(0, CODE_LABEL_MAX)}…` : lang;
}

/**
 * Put a `<pre>` inside a `.code-block`: a header (language label, 줄바꿈 toggle,
 * copy) above the code. The header's buttons are real buttons in DOM order, so
 * they are reachable by Tab and never hover-only.
 */
function wrapCodeBlock(pre: HTMLElement): void {
  const doc = pre.ownerDocument;
  const wrapper = doc.createElement("div");
  wrapper.className = "code-block";
  pre.replaceWith(wrapper);

  const head = doc.createElement("div");
  head.className = "code-head";
  const label = doc.createElement("span");
  label.className = "code-lang";
  label.textContent = codeLanguageLabel(pre);
  const actions = doc.createElement("span");
  actions.className = "code-actions";

  const wrap = doc.createElement("button");
  wrap.className = "code-wrap";
  wrap.type = "button";
  wrap.textContent = "줄바꿈";
  wrap.title = "긴 줄을 화면 너비에 맞춰 줄바꿈";
  wrap.setAttribute("aria-pressed", "false");
  wrap.addEventListener("click", (event) => {
    event.stopPropagation();
    const on = !wrapper.classList.contains("code-wrapped");
    wrapper.classList.toggle("code-wrapped", on);
    wrap.setAttribute("aria-pressed", on ? "true" : "false");
  });

  const copy = doc.createElement("button");
  copy.className = "code-copy";
  copy.type = "button";
  copy.setAttribute("aria-label", "코드 복사");
  copy.title = "코드 복사";
  copy.innerHTML = COPY_SVG;
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    // Read at click time: a block still streaming has more code by now.
    const code = pre.querySelector("code") as HTMLElement | null;
    void copyText((code ?? pre).innerText ?? (code ?? pre).textContent ?? "", copy);
  });

  actions.append(wrap, copy);
  head.append(label, actions);
  wrapper.append(head, pre);
}

/** Wrap every bare `<pre>` and `<table>` under `root` (an element or a fragment). Idempotent. */
function enhanceRendered(root: ParentNode): void {
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement?.classList.contains("code-block")) return;
    wrapCodeBlock(pre);
  });
  root.querySelectorAll("table").forEach((table) => {
    if (table.closest(".table-wrap")) return;
    const wrap = table.ownerDocument.createElement("div");
    wrap.className = "table-wrap";
    table.replaceWith(wrap);
    wrap.append(table);
  });
}

// Wrap each <pre> in a .code-block (language label, wrap toggle, copy button),
// and each <table> in a .table-wrap scroller. Idempotent — a block already
// wrapped keeps its header (and its toggle state) for as long as its html stays.
// Use as `<div use:enhanceMarkdown={source}>{@html …}</div>`;
// re-runs after the html updates because Svelte calls update() on dependency change.
//
// Pass the SAME source text the sibling {@html} renders, so an unchanged param
// can skip the sweep: Svelte re-runs update() whenever the each-block item is
// re-emitted, and `updateState` re-emits the whole appState on every SSE token.
// Without the identity check, each message already in a long transcript paid two
// querySelectorAll passes per streamed token (see renderMarkdownCached).
export function enhanceMarkdown(node: HTMLElement, param?: unknown) {
  let last = param;
  enhanceRendered(node);
  return {
    update(next?: unknown) {
      if (next === last) return;
      last = next;
      enhanceRendered(node);
    },
    destroy() {
      /* nothing to tear down */
    },
  };
}

/** One rendered top-level block of a live answer (`lib/streamMarkdown.ts`). */
export interface HtmlBlock {
  key: number | string;
  /** Sanitized html — it is inserted as is. */
  html: string;
}

interface MountedBlock {
  html: string;
  nodes: ChildNode[];
}

/** The one `.code-block` a block consists of, if that is all it is. */
function loneCodeBlock(nodes: ChildNode[]): HTMLElement | null {
  let found: HTMLElement | null = null;
  for (const node of nodes) {
    if (node.nodeType === 3 && !(node.textContent || "").trim()) continue;
    if (found || !(node instanceof HTMLElement) || !node.classList.contains("code-block")) return null;
    found = node;
  }
  return found;
}

/**
 * A code block that only GREW (a fence still streaming): update its text in
 * place instead of rebuilding it, so its header, its 줄바꿈 state, a focused
 * button, the viewer's selection and the horizontal scroll all stay.
 */
function patchCodeBlock(current: ChildNode[], fresh: ChildNode[]): boolean {
  const have = loneCodeBlock(current);
  const want = loneCodeBlock(fresh);
  if (!have || !want) return false;
  const haveCode = have.querySelector(":scope > pre > code");
  const wantCode = want.querySelector(":scope > pre > code");
  if (!haveCode || !wantCode || haveCode.childElementCount || wantCode.childElementCount) return false;
  const nextClass = wantCode.getAttribute("class");
  if (nextClass === null) haveCode.removeAttribute("class");
  else if (haveCode.getAttribute("class") !== nextClass) haveCode.setAttribute("class", nextClass);
  const label = have.querySelector(":scope > .code-head > .code-lang");
  const nextLabel = codeLanguageLabel(want);
  if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
  const before = haveCode.textContent ?? "";
  const after = wantCode.textContent ?? "";
  const text = haveCode.firstChild;
  if (text && text.nodeType === 3 && haveCode.childNodes.length === 1 && after.startsWith(before)) {
    if (after.length > before.length) (text as Text).appendData(after.slice(before.length));
  } else if (before !== after) {
    haveCode.textContent = after;
  }
  return true;
}

/**
 * Draw a live answer's blocks into `node`, touching only the blocks whose html
 * changed. Use as `<div class="md" use:markdownBlocks={blocks}>…</div>` with the
 * array `createStreamMarkdown().render()` returns.
 *
 * Why not `{#each}{@html}`: the nodes go straight into `node`, with no wrapper
 * per block, so the DOM is the same tree a whole `{@html}` render produces
 * (`.md > :first-child`, sibling margins and the rest of the prose CSS apply
 * unchanged) — and a code block's wrapper, which `{@html}` does not know about,
 * is removed with its block instead of being left behind.
 *
 * The blocks sit BEFORE anything Svelte renders inside `node` (the stream caret).
 */
export function markdownBlocks(node: HTMLElement, blocks: readonly HtmlBlock[] = []) {
  const end = node.ownerDocument.createComment("");
  node.insertBefore(end, node.firstChild);
  const template = node.ownerDocument.createElement("template");
  let mounted: MountedBlock[] = [];
  let last: readonly HtmlBlock[] | null = null;

  const build = (html: string): ChildNode[] => {
    template.innerHTML = html;
    enhanceRendered(template.content);
    return Array.from(template.content.childNodes);
  };
  /** The node block `index` goes in front of: the next block that has any, else the end marker. */
  const nextNode = (index: number): ChildNode => {
    for (let i = index + 1; i < mounted.length; i += 1) {
      if (mounted[i].nodes.length) return mounted[i].nodes[0];
    }
    return end;
  };

  const apply = (next: readonly HtmlBlock[]): void => {
    if (next === last) return;
    last = next;
    for (let i = 0; i < next.length; i += 1) {
      const current = mounted[i];
      const html = next[i].html;
      if (current && current.html === html) continue;
      const fresh = build(html);
      if (current && patchCodeBlock(current.nodes, fresh)) {
        current.html = html;
        continue;
      }
      const before = nextNode(i);
      if (current) for (const old of current.nodes) old.remove();
      for (const child of fresh) node.insertBefore(child, before);
      mounted[i] = { html, nodes: fresh };
    }
    for (let i = next.length; i < mounted.length; i += 1) {
      for (const old of mounted[i].nodes) old.remove();
    }
    mounted.length = next.length;
  };

  apply(blocks);
  return {
    update(next: readonly HtmlBlock[] = []) {
      apply(next);
    },
    destroy() {
      for (const block of mounted) for (const old of block.nodes) old.remove();
      mounted = [];
      end.remove();
    },
  };
}
