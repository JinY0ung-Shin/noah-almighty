import { describe, expect, it } from "vitest";
import { repoToHref, formatUsageLabel } from "../src/client/src/lib/format.js";
import { escapeHtml } from "../src/client/src/lib/html.js";

describe("escapeHtml", () => {
  it("escapes the five characters that matter in text and quoted attributes", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
    expect(escapeHtml("평범한 글")).toBe("평범한 글");
  });
});

describe("formatUsageLabel", () => {
  it("shows context occupancy (fill %) + cumulative output", () => {
    expect(
      formatUsageLabel({ inputTokens: 20703, outputTokens: 107, contextWindow: 1_000_000 }),
    ).toBe("컨텍스트 20.7K/1000K (2%) · 출력 107");
  });

  it("appends the reasoning share when the SDK reports thinking tokens", () => {
    expect(
      formatUsageLabel({ inputTokens: 50_000, outputTokens: 5_000, thinkingTokens: 4_200, contextWindow: 1_000_000 }),
    ).toContain("출력 5.0K (추론 4.2K)");
  });

  it("falls back to output-only when there is no honest occupancy snapshot", () => {
    // input === 0 marks a no-snapshot turn (server zeroed it); never show "입력 0".
    expect(formatUsageLabel({ inputTokens: 0, outputTokens: 9_000 })).toBe("출력 9.0K");
  });

  it("omits the reasoning share when thinking is 0 or absent", () => {
    expect(formatUsageLabel({ inputTokens: 100, outputTokens: 40 })).not.toContain("추론");
    expect(formatUsageLabel({ inputTokens: 100, outputTokens: 40, thinkingTokens: 0 })).not.toContain("추론");
  });

  it("returns empty when there is nothing to show", () => {
    expect(formatUsageLabel(null)).toBe("");
    expect(formatUsageLabel({ inputTokens: 0, outputTokens: 0 })).toBe("");
  });
});

describe("repoToHref", () => {
  it("returns null for null/empty/whitespace repo", () => {
    expect(repoToHref(null, "github.com")).toBeNull();
    expect(repoToHref("", "github.com")).toBeNull();
    expect(repoToHref("   ", "github.com")).toBeNull();
  });

  it("builds an href from owner/repo shorthand against the given host", () => {
    expect(repoToHref("owner/repo", "github.example.com")).toBe(
      "https://github.example.com/owner/repo",
    );
  });

  it("defaults to github.com when the host is empty", () => {
    expect(repoToHref("owner/repo", "")).toBe("https://github.com/owner/repo");
  });

  it("normalizes a host given with protocol and trailing slash", () => {
    expect(repoToHref("owner/repo", "https://ghe.corp/")).toBe(
      "https://ghe.corp/owner/repo",
    );
  });

  it("returns a full https URL as-is except for a trailing .git", () => {
    expect(repoToHref("https://github.com/owner/repo", "github.com")).toBe(
      "https://github.com/owner/repo",
    );
    expect(repoToHref("https://github.com/owner/repo.git", "github.com")).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("strips a trailing .git from owner/repo shorthand in the built URL", () => {
    expect(repoToHref("owner/repo.git", "github.example.com")).toBe(
      "https://github.example.com/owner/repo",
    );
  });

  it("returns null for a value that is neither a URL nor owner/repo shorthand", () => {
    expect(repoToHref("just-a-word", "github.com")).toBeNull();
    expect(repoToHref("a/b/c with spaces", "github.com")).toBeNull();
  });
});
