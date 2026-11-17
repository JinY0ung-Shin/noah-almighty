// What a side-panel tab or an answer fits into a narrow column opens in 크게 보기
// (lib/zoomViewer.ts) on a press: a page or image (ZoomableImage) and an inline
// <svg> (WidgetSvg). jsdom never lays out, so what is pinned here is the way in
// and what the viewer is handed; the zoom itself is a real-browser check
// (tests/visual/inline-ui.spec.ts, canvas-isolation.spec.ts).
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import ZoomableImage from "../src/client/src/components/ZoomableImage";
import WidgetSvg from "../src/client/src/components/widget/WidgetSvg";
import type { SvgTree } from "../src/shared/widget/index";

const viewer = (): HTMLElement | null => document.querySelector<HTMLElement>("body > .zoom-viewer");
/** The viewer is a lazy chunk: it is there a moment after the press (longer than waitFor's 1 s when the whole suite runs). */
const opened = (): Promise<HTMLElement> =>
  waitFor(
    () => {
      const dialog = viewer();
      if (!dialog) throw new Error("the viewer did not open");
      return dialog;
    },
    { timeout: 10_000 },
  );
const escape = (): void => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
};

afterEach(() => {
  escape();
});

describe("ZoomableImage", () => {
  it("is a real button around the picture, which keeps its reserved box", () => {
    const { container } = render(<ZoomableImage src="/api/x/1" alt="보고서 2쪽" title="보고서.pdf — 2 / 5" size={{ width: 1240, height: 1754 }} loading="lazy" />);
    const button = container.querySelector<HTMLButtonElement>("button.cmp-zoomable-image")!;
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("보고서 2쪽 크게 보기");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    const img = button.querySelector("img")!;
    expect([img.getAttribute("src"), img.getAttribute("alt"), img.getAttribute("width"), img.getAttribute("height"), img.getAttribute("loading")]).toEqual([
      "/api/x/1",
      "보고서 2쪽",
      "1240",
      "1754",
      "lazy",
    ]);
  });

  it("opens the same picture in the viewer, at its recorded size, and Escape hands focus back", async () => {
    const { container } = render(<ZoomableImage src="/api/x/1" alt="보고서 2쪽" title="보고서.pdf — 2 / 5" size={{ width: 1240, height: 1754 }} />);
    const button = container.querySelector<HTMLButtonElement>("button")!;
    button.focus();
    fireEvent.click(button);
    const dialog = await opened();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("보고서 2쪽 크게 보기");
    expect(dialog.querySelector(".zoom-viewer-name")?.textContent).toBe("보고서.pdf — 2 / 5");
    const img = dialog.querySelector<HTMLImageElement>("img.zoom-viewer-image")!;
    expect([img.getAttribute("src"), img.alt, img.draggable]).toEqual(["/api/x/1", "보고서 2쪽", false]);
    // jsdom lays nothing out, so the fit is 100%: the box is the recorded size.
    const box = dialog.querySelector<HTMLElement>(".zoom-viewer-content")!;
    expect([box.style.width, box.style.height]).toEqual(["1240px", "1754px"]);
    // A second press while it is open does not stack another one.
    fireEvent.click(button);
    expect(document.querySelectorAll("body > .zoom-viewer")).toHaveLength(1);

    escape();
    expect(viewer()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("learns the size of a picture that has none recorded when its bytes arrive", async () => {
    const { container } = render(<ZoomableImage src="/api/ws/a.png" alt="a.png" title="a.png" />);
    fireEvent.click(container.querySelector("button")!);
    const dialog = await opened();
    const box = dialog.querySelector<HTMLElement>(".zoom-viewer-content")!;
    const img = dialog.querySelector<HTMLImageElement>("img")!;
    Object.defineProperty(img, "naturalWidth", { value: 1920 });
    Object.defineProperty(img, "naturalHeight", { value: 1080 });
    fireEvent.load(img);
    expect([box.style.width, box.style.height]).toEqual(["1920px", "1080px"]);
  });
});

describe("WidgetSvg", () => {
  const tree = (width: string, viewBox = "0 0 100 50"): SvgTree => ({
    tag: "svg",
    attrs: [
      ["viewBox", viewBox],
      ["width", width],
    ],
    children: [{ tag: "rect", attrs: [["width", "100"], ["height", "50"]], children: [] }],
  });

  it("draws in a shadow root inside its box, with a corner button that opens it in the viewer", async () => {
    const { container } = render(<WidgetSvg tree={tree("400")} label="구조도" />);
    const box = container.querySelector<HTMLElement>(".wg-svg")!;
    expect(box.classList.contains("is-zoomable")).toBe(true);
    const drawing = box.querySelector<HTMLElement>(".wg-svg-drawing")!;
    expect(drawing.getAttribute("role")).toBe("img");
    expect(drawing.getAttribute("aria-label")).toBe("구조도");
    expect(drawing.shadowRoot?.querySelector("svg rect")).not.toBeNull();
    const zoom = box.querySelector<HTMLButtonElement>("button.wg-svg-zoom")!;
    expect(zoom.getAttribute("aria-label")).toBe("구조도 크게 보기");

    fireEvent.click(zoom);
    const dialog = await opened();
    expect(dialog.getAttribute("aria-label")).toBe("구조도 크게 보기");
    const shown = dialog.querySelector(".zoom-viewer-svg")!.shadowRoot!.querySelector("svg")!;
    expect(shown.querySelector("rect")).not.toBeNull();
    // 100% is the size the answer draws it at (400px wide, by the viewBox's ratio), not the viewBox's units.
    const content = dialog.querySelector<HTMLElement>(".zoom-viewer-content")!;
    expect([content.style.width, content.style.height]).toEqual(["400px", "200px"]);
  });

  it("opens on a press on the drawing too, and an open viewer follows the drawing", async () => {
    const { container, rerender } = render(<WidgetSvg tree={tree("400")} />);
    fireEvent.click(container.querySelector(".wg-svg-drawing")!);
    const dialog = await opened();
    expect(dialog.getAttribute("aria-label")).toBe("그림 크게 보기");
    rerender(<WidgetSvg tree={{ ...tree("400"), children: [{ tag: "circle", attrs: [["r", "5"]], children: [] }] }} />);
    expect(dialog.querySelector(".zoom-viewer-svg")!.shadowRoot!.querySelector("circle")).not.toBeNull();
  });

  it("leaves a small drawing (an icon, a sparkline) alone", () => {
    const { container } = render(<WidgetSvg tree={tree("100")} />);
    expect(container.querySelector(".wg-svg")!.classList.contains("is-zoomable")).toBe(false);
    expect(container.querySelector("button")).toBeNull();
    fireEvent.click(container.querySelector(".wg-svg-drawing")!);
    expect(viewer()).toBeNull();
  });
});
