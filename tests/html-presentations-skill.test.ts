// The bundled `html-presentations` skill (default-skills/skills/html-presentations, adapted from
// ericmjl/skills — see its NOTICE.md). What it must keep: a deck is ONE .html file that reads WITHOUT
// script, because Noah's 파일 tab draws a page with its scripts removed and fits the frame to the page's
// height (lib/canvasHtml.ts). These are text checks of the page shell the skill teaches and of its
// exemplar; the two renders themselves were looked at in Chromium (docs/architecture/html-presentations-skill.md).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listPluginRootSkills } from "../src/server/agent/skillCatalog.js";

const ROOT = path.join(process.cwd(), "default-skills");
const SKILL = path.join(ROOT, "skills", "html-presentations");
const read = (file: string): string => fs.readFileSync(path.join(SKILL, file), "utf8");

const skillMd = read("SKILL.md");
/** The page shell: the one whole document in SKILL.md. */
const shell = skillMd.slice(skillMd.indexOf("<!DOCTYPE html>"), skillMd.indexOf("</html>") + "</html>".length);
const exemplar = read("assets/example-agent-skills-overview.html");
const pages: [string, string][] = [
  ["the page shell in SKILL.md", shell],
  ["the exemplar", exemplar],
];

/** `selector { declarations }` pairs of every <style> block (flat rules only; a @keyframes body is skipped). */
function cssRules(css: string): { selector: string; body: string }[] {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] }));
}
const styleOf = (page: string): string => [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
/** A declaration that hides an element until script reveals it. */
const HIDES = /opacity:\s*0(?![.\d])|transform:\s*scale\(0\)|stroke-dashoffset:\s*var\(--len|visibility:\s*hidden|display:\s*none/;
/** What is hidden on purpose where scripts are off: the deck-mode chrome. */
const DECK_ONLY = new Set([".nav-bar", ".overview-overlay"]);
const slidesOf = (page: string): string => page.slice(page.indexOf('<div class="deck">'), page.indexOf('<div class="nav-bar">'));

describe("html-presentations skill", () => {
  it("is a bundled skill whose description sends PowerPoint requests to the pptx skill", () => {
    const found = listPluginRootSkills([ROOT]).find((skill) => skill.name === "html-presentations");
    expect(found).toBeDefined();
    // The skill index cuts a description at 300 characters (piSkills MAX_DESCRIPTION_CHARS).
    expect(found!.description.length).toBeLessThanOrEqual(300);
    expect(found!.description).toContain("ONLY when the user explicitly asks for an HTML");
    expect(found!.description).toContain("belongs to the pptx skill");
  });

  it.each(pages)("%s turns into a deck only through the script in <head>", (_name, page) => {
    expect(page.length).toBeGreaterThan(5_000);
    const head = page.slice(0, page.indexOf("<style>"));
    expect(head).toContain("<script>document.documentElement.className = 'js';</script>");
    const rules = cssRules(styleOf(page));
    // Deck mode — one slide over the other, all but one transparent — exists under .js only.
    const slideRule = rules.find((rule) => rule.selector === ".slide");
    expect(slideRule?.body).toContain("position: relative");
    expect(slideRule?.body).toContain("min-height: 56.25vw");
    expect(rules.find((rule) => rule.selector === ".js .slide")?.body).toMatch(/position:\s*absolute[\s\S]*opacity:\s*0/);
  });

  it.each(pages)("%s hides nothing where scripts are off, except the deck-mode chrome", (_name, page) => {
    const hidden = cssRules(styleOf(page)).filter((rule) => HIDES.test(rule.body) && !DECK_ONLY.has(rule.selector));
    expect(hidden.length).toBeGreaterThan(0);
    for (const rule of hidden) {
      for (const selector of rule.selector.split(",")) {
        expect(selector.trim(), `"${selector.trim()}" hides an element without script`).toMatch(/^\.js\b/);
      }
    }
    // No hidden start state written on an element either.
    expect(slidesOf(page)).not.toMatch(/style="[^"]*(opacity:\s*0(?![.\d])|visibility:\s*hidden|display:\s*none)/);
  });

  it.each(pages)("%s uses no vh inside a slide (the frame is fitted to the page's height)", (_name, page) => {
    const slides = slidesOf(page);
    expect(slides).toContain('<section class="slide"');
    expect(slides).not.toMatch(/\dvh\b/);
    // The slide's own box and the type inside it are sized by width.
    for (const rule of cssRules(styleOf(page))) {
      if (/^\.js\b/.test(rule.selector) || /^\.(nav-|overview-|progress)/.test(rule.selector)) continue;
      expect(rule.body, rule.selector).not.toMatch(/\dvh\b/);
    }
  });

  it("the exemplar is one self-contained file: nothing is loaded from elsewhere", () => {
    expect(exemplar).not.toMatch(/<link\b|@import|<script[^>]+src=|<img[^>]+src="https?:|url\(\s*["']?https?:/i);
    // Every supplementary link is also an ordinary link to its slide.
    const links = [...exemplar.matchAll(/<a class="supp-link"([^>]*)>/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const attrs of links) {
      const target = attrs.match(/data-goto="([^"]+)"/)?.[1];
      expect(attrs).toContain(`href="#${target}"`);
      expect(exemplar).toContain(`id="${target}"`);
    }
  });

  it("the animation reference keeps every hidden start state under .js", () => {
    const css = [...read("references/svg-animations.md").matchAll(/```css\n([\s\S]*?)```/g)].map((m) => m[1]).join("\n");
    const hidden = cssRules(css).filter((rule) => HIDES.test(rule.body));
    expect(hidden.length).toBeGreaterThan(0);
    for (const rule of hidden) expect(rule.selector).toMatch(/^\.js\b/);
  });

  it("tells the avatar how the file is read and delivered, and names its source", () => {
    expect(skillMd).toContain("## Two ways the file is read");
    expect(skillMd).toContain("mcp__file_output__share_file");
    expect(skillMd).toContain("never copy the page into a canvas");
    // Left out of Noah's copy (NOTICE.md says so).
    expect(skillMd).not.toContain("deck tenets");
    expect(skillMd).not.toContain("uv run");
    expect(fs.existsSync(path.join(SKILL, "assets", "canvas-chat-overview.html"))).toBe(false);
    expect(read("NOTICE.md")).toContain("https://github.com/ericmjl/skills");
  });
});
