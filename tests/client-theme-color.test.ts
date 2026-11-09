// cssColor/normalizeColor: color tokens handed to a renderer with its own parser (cytoscape). The production CSS
// minifier rewrites `rgba(r, g, b, a)` to `#rrggbbaa`, which cytoscape rejects — it then falls back to its default
// black label box, so the knowledge graph showed black boxes instead of note titles in deployed builds only.
import { describe, expect, it } from "vitest";
import { cssColor, normalizeColor } from "../src/client/src/lib/theme.js";

describe("normalizeColor", () => {
  it("turns the minifier's 8- and 4-digit hex back into rgba()", () => {
    expect(normalizeColor("#ffffffe0")).toBe("rgba(255, 255, 255, 0.878)");
    expect(normalizeColor("#242426e0")).toBe("rgba(36, 36, 38, 0.878)");
    expect(normalizeColor("#3c3c432e")).toBe("rgba(60, 60, 67, 0.18)");
    expect(normalizeColor("#fff6")).toBe("rgba(255, 255, 255, 0.4)");
    expect(normalizeColor(" #000000FF ")).toBe("rgba(0, 0, 0, 1)");
  });

  it("keeps colors every parser already accepts unchanged", () => {
    for (const c of ["#fff", "#1d1d1f", "rgb(1, 2, 3)", "rgba(255, 255, 255, 0.88)", "hsl(0, 100%, 50%)"]) {
      expect(normalizeColor(c)).toBe(c);
    }
  });

  it("returns null for a non-color when no browser canvas is available", () => {
    expect(normalizeColor("")).toBeNull();
    expect(normalizeColor("var(--x)")).toBeNull();
  });
});

describe("cssColor", () => {
  it("falls back outside a browser", () => {
    expect(cssColor("--panel", "#ffffff")).toBe("#ffffff");
  });
});
