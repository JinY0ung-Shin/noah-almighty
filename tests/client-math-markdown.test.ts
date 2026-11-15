// @vitest-environment jsdom
//
// Math in rendered Markdown (lib/mathMarkdown.ts + lib/mathRender.ts): which
// text is a formula (never currency, never code, never an unclosed `$$` of an
// answer still streaming), the placeholder the html carries, and KaTeX's
// MathML output after its own allowlist.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/client/src/lib/format.js";
import { inlineMath, syncMath } from "../src/client/src/lib/mathMarkdown.js";
import { renderMathHtml, sanitizeMathHtml } from "../src/client/src/lib/mathRender.js";
import { renderMarkdownBlocks } from "../src/client/src/lib/streamMarkdown.js";

/** The TeX of every formula placeholder in the html, `D:` for display. */
function formulas(html: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = html;
  return Array.from(host.querySelectorAll<HTMLElement>(".md-math")).map((el) => `${el.dataset.display !== undefined ? "D" : "I"}:${el.dataset.tex}`);
}

describe("math delimiters", () => {
  it("finds inline and display formulas", () => {
    expect(formulas(renderMarkdown("원금 $P$와 이율 $r$, 그리고 \\(n\\)개월"))).toEqual(["I:P", "I:r", "I:n"]);
    expect(formulas(renderMarkdown("$$M = P\\frac{r(1+r)^n}{(1+r)^n-1}$$"))).toEqual(["D:M = P\\frac{r(1+r)^n}{(1+r)^n-1}"]);
    expect(formulas(renderMarkdown("앞 문단\n\n$$\na^2 + b^2 = c^2\n$$\n\n뒤 문단"))).toEqual(["D:a^2 + b^2 = c^2"]);
    expect(formulas(renderMarkdown("\\[\nx = 1\n\\]"))).toEqual(["D:x = 1"]);
    expect(formulas(renderMarkdown("문장 안 $$x^2$$ 표시"))).toEqual(["D:x^2"]);
  });

  it("leaves currency alone", () => {
    for (const text of ["$5 and $10", "가격은 $5이고 $10이다", "$5와$10", "US$5, US$10", "costs $ 5 or $10 $", "$x $"]) {
      expect(formulas(renderMarkdown(text)), text).toEqual([]);
      expect(renderMarkdown(text), text).toContain("$");
    }
    expect(inlineMath("$5 and $10")).toBeUndefined();
    expect(inlineMath("$a \\$ b$ 끝")?.tex).toBe("a \\$ b");
  });

  it("never looks into code", () => {
    expect(formulas(renderMarkdown("`$x$` 와 ```\n$$y$$\n```"))).toEqual([]);
    expect(formulas(renderMarkdown("```\n$$\nx\n$$\n```"))).toEqual([]);
    expect(formulas(renderMarkdown("$a `b` c$"))).toEqual([]);
  });

  it("keeps an unclosed $$ of a streaming answer as text, and the rest of it too", () => {
    const text = "식은 다음과 같습니다.\n\n$$\nM = P\\frac{r}{1";
    const html = renderMarkdownBlocks(text, { heal: true }).map((block) => block.html).join("");
    expect(formulas(html)).toEqual([]);
    expect(html).toContain("식은 다음과 같습니다.");
    expect(html).toContain("$$");
    // Once it is closed, it is one formula.
    expect(formulas(renderMarkdownBlocks(`${text}}\n$$\n\n끝`).map((block) => block.html).join(""))).toEqual(["D:M = P\\frac{r}{1}"]);
  });

  it("does not run over a blank line", () => {
    expect(formulas(renderMarkdown("$$a\n\nb$$"))).toEqual([]);
  });

  it("shows the source until KaTeX has drawn it, and escapes it", () => {
    const host = document.createElement("div");
    host.innerHTML = renderMarkdown('$a<b$ "x"');
    const el = host.querySelector<HTMLElement>(".md-math")!;
    expect(el.dataset.tex).toBe("a<b");
    expect(el.textContent).toBe("$a<b$");
    expect(el.childElementCount).toBe(0);
  });

  it("renders the same html block by block as whole", () => {
    const text = "# 상환액\n\n월 상환액 $M$:\n\n$$\nM = P\\frac{r(1+r)^n}{(1+r)^n-1}\n$$\n\n- $r$: 월 이율\n- $5 and $10\n";
    expect(renderMarkdownBlocks(text).map((block) => block.html).join("")).toBe(renderMarkdown(text));
  });
});

describe("KaTeX output", () => {
  it("is MathML, through the allowlist", () => {
    const html = renderMathHtml("M = P\\frac{r(1+r)^n}{(1+r)^n-1}", true);
    expect(html).toContain("<math");
    expect(html).toContain('display="block"');
    expect(html).toContain("<mfrac>");
    expect(html).not.toContain("style=");
    expect(renderMathHtml("x", false)).not.toContain('display="block"');
  });

  it("drops what is not KaTeX's MathML", () => {
    const dirty = sanitizeMathHtml(
      '<math><mi style="position:fixed" onclick="x()" href="javascript:alert(1)">x</mi><img src=x onerror=alert(1)><a href="https://e.com">a</a><maction actiontype="toggle"><mi>y</mi></maction></math>',
    );
    expect(dirty).toContain("<mi>x</mi>");
    expect(dirty).not.toMatch(/style|onclick|href|<img|<a |maction/);
  });

  it("does not trust \\href, and does not throw on bad TeX", () => {
    expect(renderMathHtml("\\href{javascript:alert(1)}{x}", false)).not.toMatch(/href=|<a /);
    expect(renderMathHtml("\\frac{", false)).toContain("katex-error");
  });

  it("draws the placeholders in place", async () => {
    const host = document.createElement("div");
    host.innerHTML = renderMarkdown("값 $x^2$");
    syncMath(host);
    // KaTeX's chunk arrives asynchronously the first time.
    await expect.poll(() => host.querySelector(".md-math math") !== null).toBe(true);
    const el = host.querySelector<HTMLElement>(".md-math")!;
    expect(el.dataset.mathDrawn).toBe("");
    expect(el.title).toBe("x^2");
    // Already loaded: the next one is drawn at once.
    const next = document.createElement("div");
    next.innerHTML = renderMarkdown("$y$");
    syncMath(next);
    expect(next.querySelector("math")).not.toBeNull();
  });
});
