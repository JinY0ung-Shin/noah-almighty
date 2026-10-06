// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { canvasHtmlDocument } from "../src/client/src/lib/canvasHtml.js";

// The srcdoc as the frame will parse it.
function parse(doc: string): Document {
  return new DOMParser().parseFromString(doc, "text/html");
}

describe("canvasHtmlDocument", () => {
  it("keeps a <style> that leads the content", () => {
    // The bug: a body-only sanitize let the parser hoist this into <head> and drop it.
    const page = parse(canvasHtmlDocument('<style>.card{color:red}</style><div class="card">hi</div>', "light"));
    const styles = [...page.querySelectorAll("style")].map((s) => s.textContent);
    expect(styles).toContain(".card{color:red}");
    expect(page.querySelector(".card")?.textContent).toBe("hi");
  });

  it("keeps a whole document's head styles and attributes but no script or handler", () => {
    const page = parse(
      canvasHtmlDocument(
        '<!DOCTYPE html><html lang="ko"><head><title>T</title><style>body{margin:2rem}</style>' +
          '<script>parent.pwned = 1</script></head><body class="page" onload="x()"><p onclick="y()">본문</p></body></html>',
        "light",
      ),
    );
    expect(page.documentElement.getAttribute("lang")).toBe("ko");
    expect(page.body.className).toBe("page");
    expect([...page.head.querySelectorAll("style")].map((s) => s.textContent)).toContain("body{margin:2rem}");
    expect(page.querySelector("script")).toBeNull();
    expect(page.body.hasAttribute("onload")).toBe(false);
    expect(page.querySelector("p")?.hasAttribute("onclick")).toBe(false);
  });

  it("puts the theme base sheet first, so the page's own CSS overrides it", () => {
    const doc = canvasHtmlDocument("<style>body{color:blue}</style><p>x</p>", "dark");
    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
    const sheets = [...parse(doc).head.querySelectorAll("style")].map((s) => s.textContent ?? "");
    expect(sheets).toHaveLength(2);
    expect(sheets[0]).toContain("color-scheme: dark");
    expect(sheets[1]).toBe("body{color:blue}");
    expect(canvasHtmlDocument("<p>x</p>", "light")).toContain("color-scheme: light");
  });

  it("copies the app's font faces inline instead of fetching a stylesheet", () => {
    // A fetched sheet render-blocks the frame: a hung one left the page blank.
    const appSheet = document.createElement("style");
    appSheet.textContent = '@font-face { font-family: "Noto Sans KR Variable"; src: url(/assets/noto.woff2); }';
    document.head.append(appSheet);
    try {
      const base = parse(canvasHtmlDocument("<p>한글</p>", "light")).head.querySelector("style")?.textContent ?? "";
      expect(base).toContain("@font-face");
      expect(base).toContain("Noto Sans KR Variable");
      expect(base).not.toContain("@import");
    } finally {
      appSheet.remove();
    }
  });
});
