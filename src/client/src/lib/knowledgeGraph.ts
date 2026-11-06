import type { KnowledgeGraph, KnowledgeGraphNode } from "./types";

// Client-side helpers over a `[[wikilink]]` KnowledgeGraph, shared by the graph
// canvas (colors, degrees) and the brain view's note panel (links, backlinks,
// clickable wikilinks in the rendered note).

// Vault-section colors (chosen to read on both light and dark themes).
// DELIBERATE token-system exemption: this is a categorical data-viz palette
// encoding a node's section, not UI chrome. It needs 8 mutually distinguishable
// hues, which the semantic token set doesn't provide — so it stays raw hex and
// stays theme-independent (the same hue must mean the same section in both).
export const SECTION_COLORS: Record<string, string> = {
  raw: "#f59e0b",
  sources: "#3b82f6",
  entities: "#10b981",
  concepts: "#8b5cf6",
  synthesis: "#ef4444",
  wiki: "#64748b",
  other: "#94a3b8",
  unresolved: "#94a3b8",
};

export const SECTION_LABELS: Record<string, string> = {
  raw: "raw (캡처)",
  sources: "sources",
  entities: "entities",
  concepts: "concepts",
  synthesis: "synthesis",
  wiki: "wiki",
  other: "기타",
  unresolved: "미연결 링크",
};

/** Legend / filter order: the vault's own reading order, dangling targets last. */
export const SECTION_ORDER = ["raw", "sources", "entities", "concepts", "synthesis", "wiki", "other", "unresolved"];

export function sectionColor(section: string): string {
  return SECTION_COLORS[section] ?? SECTION_COLORS.other;
}

export function sectionLabel(section: string): string {
  return SECTION_LABELS[section] ?? section;
}

/** Link count per node id (in + out, each de-duplicated edge counted once per end). */
export function nodeDegrees(graph: KnowledgeGraph): Map<string, number> {
  const degree = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return degree;
}

/** The most-linked real notes first (ties by label), for the "주요 노트" list. */
export function topNotes(graph: KnowledgeGraph, limit: number): { node: KnowledgeGraphNode; degree: number }[] {
  const degree = nodeDegrees(graph);
  return graph.nodes
    .filter((n) => !n.dangling)
    .map((node) => ({ node, degree: degree.get(node.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree || a.node.label.localeCompare(b.node.label, "ko"))
    .slice(0, limit);
}

/** Notes this node links to, and notes linking to it — each sorted by label. */
export function nodeLinks(graph: KnowledgeGraph, id: string): { outgoing: KnowledgeGraphNode[]; incoming: KnowledgeGraphNode[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const pick = (ids: string[]) =>
    [...new Set(ids)]
      .map((nid) => byId.get(nid))
      .filter((n): n is KnowledgeGraphNode => Boolean(n))
      .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  return {
    outgoing: pick(graph.edges.filter((e) => e.source === id).map((e) => e.target)),
    incoming: pick(graph.edges.filter((e) => e.target === id).map((e) => e.source)),
  };
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Resolve a raw `[[target|alias#heading]]` inside to a node id, the way the
 * server's graph builder does (`knowledgeGraph.ts`): title / filename stem /
 * path-without-ext, case-insensitive, else its dangling `unresolved:` node.
 * Frontmatter aliases are not in the client graph, so an alias-only link that
 * the server resolved falls through to `null` (rendered as plain text).
 */
export function resolveWikilink(graph: KnowledgeGraph, raw: string): string | null {
  const target = norm(raw.split("|")[0].split("#")[0].split("^")[0]);
  if (!target) return null;
  for (const n of graph.nodes) {
    if (n.dangling) continue;
    const path = n.id.replace(/\.md$/i, "");
    const stem = path.split("/").pop() ?? path;
    if (norm(n.label) === target || norm(stem) === target || norm(path) === target) return n.id;
  }
  const dangling = `unresolved:${target}`;
  return graph.nodes.some((n) => n.id === dangling) ? dangling : null;
}

/** Drop a leading `---` YAML frontmatter block (shown as tags/title elsewhere, never as prose). */
export function stripFrontmatter(markdown: string): string {
  const m = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  return m ? markdown.slice(m[0].length) : markdown;
}

/** Drop a leading `# Heading` that only repeats the note's title (the panel already shows it). */
export function stripTitleHeading(markdown: string, title: string): string {
  const m = /^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(markdown);
  return m && norm(m[1]) === norm(title) ? markdown.slice(m[0].length) : markdown;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/**
 * Turn `[[wikilinks]]` into buttons (`data-wikilink` = the resolved node id) the
 * note panel delegates clicks from; an unresolvable link becomes muted text.
 * Fenced and inline code are left verbatim. The result still goes through
 * renderMarkdown's DOMPurify pass.
 */
export function linkifyWikilinks(markdown: string, graph: KnowledgeGraph): string {
  // Split on fenced blocks and inline code spans so only prose is rewritten.
  const parts = markdown.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(/\[\[([^\]\[\n]+?)\]\]/g, (_whole, inner: string) => {
        const [targetPart, alias] = inner.split("|");
        const text = escapeHtml((alias ?? targetPart).trim() || inner);
        const id = resolveWikilink(graph, inner);
        if (!id) return `<span class="wikilink missing">${text}</span>`;
        const dangling = id.startsWith("unresolved:");
        return `<button type="button" class="wikilink${dangling ? " dangling" : ""}" data-wikilink="${escapeHtml(id)}">${text}</button>`;
      });
    })
    .join("");
}
