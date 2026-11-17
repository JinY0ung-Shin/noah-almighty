// The size a drawing is drawn at (lib/diagramSize.ts): what the answer's floor
// under a diagram's fit and the 크게 보기 view's 100% are measured from.
import { describe, expect, it } from "vitest";

import { MIN_READABLE_SCALE, svgNaturalSize } from "../src/client/src/lib/diagramSize.js";

const svg = (attrs: Record<string, string>) => ({ getAttribute: (name: string) => attrs[name] ?? null });

describe("svgNaturalSize", () => {
  it("takes a mermaid diagram's viewBox (its width is a percentage)", () => {
    expect(svgNaturalSize(svg({ viewBox: "0 0 1000 400", width: "100%" }))).toEqual({ width: 1000, height: 400 });
    expect(svgNaturalSize(svg({ viewBox: "-8,-8,516.5,120" }))).toEqual({ width: 516.5, height: 120 });
  });

  it("takes pixel width and height as they are", () => {
    expect(svgNaturalSize(svg({ width: "2000", height: "400", viewBox: "0 0 20 4" }))).toEqual({ width: 2000, height: 400 });
    expect(svgNaturalSize(svg({ width: "300px", height: "150px" }))).toEqual({ width: 300, height: 150 });
  });

  it("gives one pixel side its other side by the viewBox's ratio (an inline <svg>)", () => {
    expect(svgNaturalSize(svg({ viewBox: "0 0 100 100", width: "140" }))).toEqual({ width: 140, height: 140 });
    expect(svgNaturalSize(svg({ viewBox: "0 0 200 100", height: "50" }))).toEqual({ width: 100, height: 50 });
  });

  it("is null for a drawing that states no size in px", () => {
    const sizeless: Record<string, string>[] = [{}, { width: "100%" }, { width: "20em", height: "10em" }, { width: "300" }, { viewBox: "0 0 0 100" }, { viewBox: "0 0 100" }, { viewBox: "a b c d" }];
    for (const attrs of sizeless) {
      expect(svgNaturalSize(svg(attrs)), JSON.stringify(attrs)).toBeNull();
    }
    expect(svgNaturalSize(null)).toBeNull();
  });

  it("keeps the floor where a 16px label is still about 10px", () => {
    expect(MIN_READABLE_SCALE).toBe(0.6);
  });
});
