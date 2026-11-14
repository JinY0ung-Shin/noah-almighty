// GraphCanvas — the knowledge-graph view shared by BrainView and GraphViewModal.
// cytoscape draws on a canvas jsdom does not have, so it is stubbed to fail; the
// search box (the keyboard route to every node) renders without it.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import GraphCanvas from "../src/client/src/components/GraphCanvas";
import type { KnowledgeGraph } from "../src/client/src/lib/types";

vi.mock("cytoscape", () => ({
  default: () => {
    throw new Error("no canvas in jsdom");
  },
}));

const graph: KnowledgeGraph = {
  nodes: [
    { id: "wiki/concepts/deploy.md", label: "배포 절차", section: "concepts", tags: [] },
    { id: "wiki/concepts/review.md", label: "코드 리뷰", section: "concepts", tags: [] },
  ],
  edges: [{ source: "wiki/concepts/deploy.md", target: "wiki/concepts/review.md" }],
};

describe("GraphCanvas search", () => {
  it("leaves Enter to an IME that is still composing, then picks the match once it commits", () => {
    const onSelect = vi.fn();
    render(<GraphCanvas graph={graph} onSelect={onSelect} />);
    const box = screen.getByRole("combobox", { name: "노트 검색" });

    fireEvent.change(box, { target: { value: "배포" } });
    // fireEvent returns true when the handler did NOT preventDefault.
    expect(fireEvent.keyDown(box, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(box, { key: "Enter", keyCode: 229 })).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ id: "wiki/concepts/deploy.md" });
  });
});
