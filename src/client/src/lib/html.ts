// HTML text escaping for markup the client builds as a string (it still goes
// through the markdown sanitizer afterwards). Dependency-free on purpose:
// format.ts imports mathMarkdown.ts, so the helper cannot live in format.ts.

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape `& < > " '` — safe in element text AND in a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}
