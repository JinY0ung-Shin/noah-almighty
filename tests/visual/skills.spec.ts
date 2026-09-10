import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// 스킬 배우기 (#skill-share) visual pin: the populated learnable grid + own-skill
// share panel, on deterministic stubbed data. The preview modal is exercised
// functionally but NOT pinned — .modal-card's backdrop-filter material does not
// rasterize under headless --disable-gpu (verified: computed styles are correct
// while the paint shows through), so a pixel pin would assert the artifact.

const user = {
  id: "user-1",
  username: "jinyoung",
  displayName: "김진영",
  alias: "진영",
  bio: "",
  intro: "",
  hashtags: [],
  onboardedAt: "2026-07-01T00:00:00.000Z",
  lastSeenRelease: CURRENT_RELEASE_ID,
  knowledgeRepo: "knowledge/repo",
  gitTokenSet: true,
  secretNames: [],
};

const owner = (id: string, username: string, displayName: string, alias = "") => ({
  id,
  username,
  displayName,
  alias,
  hasImage: false,
});

const LEARNABLE = [
  {
    // The viewer's OWN share riding the feed ("나" badge, no learn button).
    id: "s0",
    ownerUserId: "user-1",
    skillName: "brain-tips",
    displayName: "brain-tips",
    description: "세컨드 브레인 활용 팁 모음",
    learnCount: 5,
    contentHash: "hash-own",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    owner: { id: "user-1", username: "jinyoung", displayName: "김진영", alias: "진영", hasImage: false },
  },
  {
    // Learned at hash-v1, share now at hash-v2 → 업데이트 있음 / 업데이트 받기.
    id: "s1",
    ownerUserId: "u2",
    skillName: "pptx-report",
    displayName: "주간 보고 덱 생성",
    description:
      "매주 반복되는 주간 보고를 표준 템플릿으로 만들어 주는 스킬입니다. 데이터 표를 붙여 넣으면 요약 슬라이드와 차트 슬라이드를 만들어요.",
    learnCount: 12,
    contentHash: "hash-v2",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-07T09:30:00.000Z",
    owner: owner("u2", "sujin", "박수진", "수지"),
  },
  {
    id: "s2",
    ownerUserId: "u3",
    skillName: "code-review",
    displayName: "code-review",
    description: "리뷰 체크리스트",
    learnCount: 3,
    contentHash: "hash-cr",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-06T02:00:00.000Z",
    owner: owner("u3", "minho", "이민호"),
  },
  {
    id: "s3",
    ownerUserId: "u2",
    skillName: "meeting-notes",
    displayName: "회의록 정리",
    description: "",
    learnCount: 0,
    contentHash: "hash-mn",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-05T11:00:00.000Z",
    owner: owner("u2", "sujin", "박수진", "수지"),
  },
];

const MINE = {
  repoConfigured: true,
  skills: [
    {
      slug: "brain-tips",
      name: "brain-tips",
      description: "세컨드 브레인 활용 팁 모음",
      shared: true,
      learnCount: 5,
      origin: null,
    },
    {
      slug: "pptx-report",
      name: "pptx-report",
      description: "",
      shared: false,
      learnCount: 0,
      origin: {
        ownerUserId: "u2",
        ownerUsername: "sujin",
        skillName: "pptx-report",
        contentHash: "hash-v1",
      },
    },
    {
      slug: "daily-digest",
      name: "daily-digest",
      description: "",
      shared: false,
      learnCount: 0,
      origin: null,
    },
  ],
};

async function mockApp(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body: Record<string, unknown> = {};
    if (path === "/api/bootstrap") {
      body = { needsSetup: false, githubHost: "github.com", signupMode: "open", confluenceConfigured: false };
    } else if (path === "/api/me") {
      body = { user };
    } else if (path === "/api/skill-share/available") {
      body = { skills: LEARNABLE };
    } else if (path.startsWith("/api/skill-share/available/")) {
      body = {
        skill: LEARNABLE[0],
        content:
          "---\nname: pptx-report\ndescription: 주간 보고 덱 생성\n---\n\n# 주간 보고 덱\n\n1. 표 데이터를 받아 요약한다\n2. python-pptx로 슬라이드를 만든다\n3. 미리보기를 렌더링해 공유한다\n",
      };
    } else if (path === "/api/skill-share/mine") {
      body = MINE;
    } else if (path === "/api/conversations") {
      body = { conversations: [] };
    } else if (path.endsWith("/knowledge/requests")) {
      body = { requests: [] };
    } else if (path.endsWith("/notifications")) {
      body = { notifications: [] };
    } else if (path.endsWith("/plugins")) {
      body = { plugins: [] };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function waitForKoreanFont(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const visibleText = document.body.innerText;
        const faces = await Promise.all(
          [400, 600, 700].map((weight) =>
            document.fonts.load(`${weight} 14px "Noto Sans KR Variable"`, visibleText),
          ),
        );
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return document.fonts.status === "loaded" && faces.every((loaded) => loaded.length > 0);
      }),
    )
    .toBe(true);
  await assertNoFallbackHangul(page);
}

/**
 * `document.fonts` can report every face loaded while a text node still RENDERS
 * with the system fallback — on this Korean-font-less box that is a row of tofu
 * boxes. Text shaped by a layout forced during the app's mount task (before the
 * @font-face subsets started loading) never re-resolves in headless Chromium, and
 * `fonts.check()` / `fonts.ready` cannot see it: only the renderer knows which
 * platform font a node actually used. So ask it, and fail loudly instead of baking
 * tofu into a baseline (docs/architecture/client.md, "forced layout during mount").
 * `CSS.getPlatformFontsForNode` counts glyphs for the whole subtree, and Latin runs
 * ("@jinyoung", digits, <kbd>) legitimately use a system font, so a node is an
 * offender only when the system-font glyphs outnumber its non-Hangul characters.
 * Visually hidden nodes (the skip link) are skipped: they never reach a screenshot.
 */
async function assertNoFallbackHangul(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hangul = /[ㄱ-ㆎ가-힣]/;
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("");
      if (!hangul.test(own)) continue;
      const rect = element.getBoundingClientRect();
      // Never painted → never in a screenshot (the skip link parks at translateY(-200%)).
      if (rect.width < 2 || rect.height < 2 || rect.bottom <= 0 || rect.right <= 0) continue;
      // Collapsible whitespace runs become one space glyph; under pre/pre-wrap every
      // whitespace character is its own glyph. Everything else non-Hangul is one glyph.
      const preserved = /^(pre|pre-wrap|break-spaces)$/.test(getComputedStyle(element).whiteSpace);
      const text = element.textContent ?? "";
      const counted = preserved ? text : text.replace(/\s+/g, " ").trim();
      const nonHangul = [...counted].filter((ch) => !hangul.test(ch)).length;
      element.setAttribute("data-hangul-probe", String(nonHangul));
    }
  });
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const { root } = await client.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await client.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-hangul-probe]" });
    const offenders: string[] = [];
    for (const nodeId of nodeIds) {
      const { node } = await client.send("DOM.describeNode", { nodeId, depth: 1 });
      const attributes = node.attributes ?? [];
      const nonHangul = Number(attributes[attributes.indexOf("data-hangul-probe") + 1] ?? 0);
      const { fonts } = await client.send("CSS.getPlatformFontsForNode", { nodeId });
      const systemGlyphs = fonts.filter((font) => !font.isCustomFont).reduce((sum, font) => sum + font.glyphCount, 0);
      if (systemGlyphs > nonHangul) {
        const text = (node.children ?? []).filter((child) => child.nodeType === 3).map((child) => child.nodeValue).join("");
        offenders.push(`<${node.localName}> "${text.trim().slice(0, 24)}" → ${fonts.map((font) => `${font.familyName}×${font.glyphCount}`).join(", ")} (non-Hangul chars ${nonHangul})`);
      }
    }
    expect(offenders, "Hangul rendered with a system fallback font (tofu) — see assertNoFallbackHangul").toEqual([]);
  } finally {
    await client.detach();
    await page.evaluate(() => {
      for (const element of document.querySelectorAll("[data-hangul-probe]")) element.removeAttribute("data-hangul-probe");
    });
  }
}

test("skills view pins the explore-density layout", async ({ page }) => {
  await mockApp(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/skills");
  await expect(page.getByText("주간 보고 덱 생성")).toBeVisible();
  await waitForKoreanFont(page);
  // Pin the VIEW column only: this spec guards the skills layout; the rail is
  // pinned by the apple-ui specs (and in this stubbed run a couple of its glyph
  // subsets never load, which would bake tofu boxes into a full-page pin).
  await expect(page.locator("main.main")).toHaveScreenshot("skills-light.png");
});

test("preview modal opens with the fresh SKILL.md and the update affordance", async ({ page }) => {
  await mockApp(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/skills");
  await expect(page.getByText("주간 보고 덱 생성")).toBeVisible();
  // The pptx card carries a stale learned copy → its modal offers the update.
  await page
    .locator(".skill-card", { hasText: "주간 보고 덱 생성" })
    .getByRole("button", { name: "미리보기" })
    .click();
  await expect(page.getByText("# 주간 보고 덱")).toBeVisible();
  await expect(page.getByLabel("전수받을 새 스킬 이름")).toBeVisible();
  await expect(page.getByRole("button", { name: "업데이트 받기" }).last()).toBeEnabled();
  // Typing a new name switches the action back to a fresh copy.
  await page.getByLabel("전수받을 새 스킬 이름").fill("deck-two");
  await expect(page.getByRole("button", { name: "전수받기" }).last()).toBeEnabled();
});
