// A drawing's own <style> (an avatar's `<svg><style>`, mermaid's id-scoped sheet)
// applies inside this shadow root only — in the app's DOM it restyled the whole
// app — and its ids stay apart from another copy's (panel vs fullscreen, two
// charts of one widget). `data-fit` on the host is fit-to-width; without it the
// drawing keeps its natural size. The root is open so export can read the <svg>.
const SVG_HOST_SHEET =
  "<style>:host { display: block; } :host([data-fit]) svg { max-width: 100%; height: auto; }</style>";

/** Svelte action: draw already-SANITIZED svg markup in the node's shadow root. */
export function shadowSvg(node: HTMLElement, markup = "") {
  const root = node.shadowRoot ?? node.attachShadow({ mode: "open" });
  root.innerHTML = SVG_HOST_SHEET + markup;
  return {
    update(next = "") {
      root.innerHTML = SVG_HOST_SHEET + next;
    },
  };
}
