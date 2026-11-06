import { describe, expect, it } from "vitest";
import {
  linkifyWikilinks,
  nodeLinks,
  resolveWikilink,
  stripFrontmatter,
  stripTitleHeading,
  topNotes,
} from "../src/client/src/lib/knowledgeGraph.js";
import type { KnowledgeGraph } from "../src/server/types.js";

const graph: KnowledgeGraph = {
  nodes: [
    { id: "wiki/concepts/deploy.md", label: "배포 파이프라인", section: "concepts", tags: [] },
    { id: "wiki/concepts/rollback.md", label: "롤백 전략", section: "concepts", tags: [] },
    { id: "raw/2026-10-02.md", label: "2026-10-02", section: "raw", tags: [] },
    { id: "unresolved:비용 최적화", label: "비용 최적화", section: "unresolved", tags: [], dangling: true },
  ],
  edges: [
    { source: "wiki/concepts/deploy.md", target: "wiki/concepts/rollback.md" },
    { source: "wiki/concepts/deploy.md", target: "unresolved:비용 최적화" },
    { source: "raw/2026-10-02.md", target: "wiki/concepts/deploy.md" },
  ],
};

describe("resolveWikilink", () => {
  it("matches title, filename stem and path case-insensitively, ignoring alias and anchor", () => {
    expect(resolveWikilink(graph, "배포 파이프라인")).toBe("wiki/concepts/deploy.md");
    expect(resolveWikilink(graph, "Rollback#단계")).toBe("wiki/concepts/rollback.md");
    expect(resolveWikilink(graph, "wiki/concepts/deploy|배포")).toBe("wiki/concepts/deploy.md");
  });

  it("falls back to the dangling node, else null", () => {
    expect(resolveWikilink(graph, "비용 최적화")).toBe("unresolved:비용 최적화");
    expect(resolveWikilink(graph, "없는 노트")).toBeNull();
  });
});

describe("linkifyWikilinks", () => {
  it("turns links into buttons carrying the resolved id, with the alias as text", () => {
    const out = linkifyWikilinks("관련: [[rollback|롤백]], [[비용 최적화]], [[없음]]", graph);
    expect(out).toContain('<button type="button" class="wikilink" data-wikilink="wiki/concepts/rollback.md">롤백</button>');
    expect(out).toContain('class="wikilink dangling" data-wikilink="unresolved:비용 최적화">비용 최적화</button>');
    expect(out).toContain('<span class="wikilink missing">없음</span>');
  });

  it("leaves fenced and inline code verbatim and escapes link text", () => {
    const src = "`[[rollback]]`\n\n```\n[[rollback]]\n```\n[[<b>x</b>]]";
    const out = linkifyWikilinks(src, graph);
    expect(out).toContain("`[[rollback]]`");
    expect(out).toContain("```\n[[rollback]]\n```");
    expect(out).toContain('<span class="wikilink missing">&lt;b&gt;x&lt;/b&gt;</span>');
  });
});

describe("note text cleanup", () => {
  it("strips a leading frontmatter block only", () => {
    expect(stripFrontmatter("---\ntitle: 배포\ntags: [a]\n---\n# 본문\n")).toBe("# 본문\n");
    expect(stripFrontmatter("본문\n---\nx: 1\n---\n")).toBe("본문\n---\nx: 1\n---\n");
  });

  it("drops a first heading that only repeats the title", () => {
    expect(stripTitleHeading("# 배포 파이프라인\n\n본문", "배포 파이프라인")).toBe("\n본문");
    expect(stripTitleHeading("# 다른 제목\n본문", "배포 파이프라인")).toBe("# 다른 제목\n본문");
  });
});

describe("graph summaries", () => {
  it("lists links and backlinks, and ranks real notes by degree", () => {
    const links = nodeLinks(graph, "wiki/concepts/deploy.md");
    expect(links.outgoing.map((n) => n.id)).toEqual(["wiki/concepts/rollback.md", "unresolved:비용 최적화"]);
    expect(links.incoming.map((n) => n.id)).toEqual(["raw/2026-10-02.md"]);
    expect(topNotes(graph, 2).map((t) => [t.node.id, t.degree])).toEqual([
      ["wiki/concepts/deploy.md", 3],
      ["raw/2026-10-02.md", 1],
    ]);
  });
});
