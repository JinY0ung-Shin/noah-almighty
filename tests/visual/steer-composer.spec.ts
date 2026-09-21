import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// Mid-turn messages ("steers"): while a turn streams, a LOCAL pane's composer
// grows a second send button next to the stop button, and a steer the server
// accepted renders as a dimmed "전달 대기 중" bubble above the live bubble. These
// are geometry/structure checks (no screenshots): the composer row is a CSS grid
// with one explicit column list per attach/mic combination, so a fifth child
// that no list accounts for silently wraps onto its own row — jsdom cannot see
// that, only a real viewport can. Checked at desktop AND phone width.

const user = {
  id: "user-1",
  username: "jinyoung",
  displayName: "김진영",
  alias: "진영",
  bio: "차분하고 유용한 AI 동료를 만들고 있습니다.",
  intro: "함께 더 좋은 답을 찾습니다.",
  hashtags: ["design", "agent"],
  onboardedAt: "2026-07-01T00:00:00.000Z",
  // See apple-ui.spec.ts — an unseen release opens a click-blocking modal.
  lastSeenRelease: CURRENT_RELEASE_ID,
  knowledgeRepo: "knowledge/repo",
  gitTokenSet: true,
  secretNames: [],
};

const RUN_ID = "run-steer-1";
const CONVERSATION_ID = "conv-steer-1";

function sseFrames(frames: Array<{ event: string; data: unknown }>): string {
  return frames
    .map((frame, index) => `id: ${index + 1}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
    .join("");
}

async function mockApp(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = decodeURIComponent(new URL(request.url()).pathname);
    // The turn: an `open` frame, a steer the server accepted, some answer text —
    // and NO terminal frame, so the client treats the end of the body as a
    // dropped connection and reattaches to the run's event log…
    if (path === "/api/chat/stream" && request.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: sseFrames([
          { event: "open", data: { conversationId: CONVERSATION_ID, runId: RUN_ID } },
          {
            event: "steer",
            data: {
              steer: {
                id: "steer-1",
                text: "대기 중인 메시지",
                state: "queued",
                createdAt: "2026-09-21T00:00:00.000Z",
                followUp: false,
              },
            },
          },
          { event: "status", data: { label: "실행 중: Bash" } },
          { event: "delta", data: { text: "첫 답변을 쓰는 중입니다." } },
        ]),
      });
      return;
    }
    // …which is held open forever here, pinning the pane in its streaming state
    // with a live run id — the state the composer is being measured in.
    if (path === `/api/chat/runs/${RUN_ID}/events`) {
      await new Promise(() => {});
      return;
    }
    let body: Record<string, unknown> = {};
    if (path === "/api/bootstrap") {
      body = {
        needsSetup: false,
        githubHost: "github.com",
        signupMode: "open",
        confluenceConfigured: false,
        // The mic button is the composer's widest configuration: attach + mic +
        // steer + stop must all share the row.
        sttEnabled: true,
        modelSelection: {
          tiers: [{ id: "default", label: "기본", description: "균형", model: null }],
          locked: false,
        },
        effortSelection: {
          levels: [{ id: "high", label: "높음", description: "기본 강도" }],
          default: "high",
        },
      };
    } else if (path === "/api/me") {
      body = { user };
    } else if (path === "/api/avatars") {
      body = { avatars: [{ ...user, sharesGroup: false }] };
    } else if (path === "/api/avatars/user-1") {
      body = {
        avatar: {
          ...user,
          hasImage: false,
          pluginCount: 0,
          visibility: "group",
          updatedAt: "2026-07-12T03:00:00.000Z",
          persona: "차분하고 정확한 디자인 동료",
          isOwn: true,
          elevated: true,
          plugins: [],
        },
      };
    } else if (path === "/api/conversations") {
      body = { conversations: [] };
    } else if (path === "/api/chat/runs") {
      body = { run: null };
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

test.beforeEach(async ({ page }) => {
  await mockApp(page);
});

/**
 * Every visible child of the composer grid sits on ONE row, with the stop button
 * hugging the right edge and the textarea keeping at least `minTextareaShare` of
 * the row (phone width gives up the attach button to make that true — see
 * 40-responsive-core.css).
 */
async function expectSingleComposerRow(page: Page, minTextareaShare: number): Promise<void> {
  const box = await page.locator(".composer-box").boundingBox();
  const textarea = await page.locator(".composer-box textarea").boundingBox();
  const steer = await page.locator(".send-button.steer-send").boundingBox();
  const stop = await page.locator(".send-button.is-stop").boundingBox();
  expect(box).not.toBeNull();
  expect(textarea).not.toBeNull();
  expect(steer).not.toBeNull();
  expect(stop).not.toBeNull();
  // Same row: the two buttons' vertical centers coincide, and both fall inside
  // the textarea's own vertical extent (a wrapped button lands BELOW it).
  const centerY = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(centerY(steer!) - centerY(stop!))).toBeLessThanOrEqual(2);
  expect(centerY(stop!)).toBeGreaterThanOrEqual(textarea!.y);
  expect(centerY(stop!)).toBeLessThanOrEqual(textarea!.y + textarea!.height);
  // Order and edge: steer left of stop, stop pinned to the composer's right edge.
  expect(steer!.x + steer!.width).toBeLessThanOrEqual(stop!.x + 1);
  expect(box!.x + box!.width - (stop!.x + stop!.width)).toBeLessThanOrEqual(20);
  // The textarea still owns the row.
  expect(textarea!.width).toBeGreaterThan(box!.width * minTextareaShare);
}

test("a streaming local pane shows the mid-turn send button beside stop on one row, at desktop and phone width", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "탐색" })).toBeVisible();
  await page.getByRole("button", { name: "진영 아바타와 대화" }).click();
  await expect(page.getByRole("heading", { name: "진영 아바타와 대화" })).toBeVisible();

  const textarea = page.getByLabel("진영에게 보낼 메시지");
  await textarea.fill("첫 메시지");
  await page.getByRole("button", { name: "보내기" }).click();

  // Streaming: the send button became stop, the steer button joined the row
  // DISABLED (nothing typed yet — a stable affordance, not a keystroke surprise),
  // and the server-accepted steer renders as a pending bubble above the live one.
  const stop = page.locator(".send-button.is-stop");
  const steerButton = page.locator(".send-button.steer-send");
  await expect(stop).toBeVisible();
  await expect(steerButton).toBeVisible();
  await expect(steerButton).toBeDisabled();
  const pending = page.locator(".message.user.steer-pending");
  await expect(pending).toHaveCount(1);
  await expect(pending).toContainText("전달 대기 중");
  await expect(pending).toContainText("대기 중인 메시지");
  const pendingBox = await pending.boundingBox();
  const liveBox = await page.locator(".transcript-inner .message.assistant").last().boundingBox();
  expect(pendingBox).not.toBeNull();
  expect(liveBox).not.toBeNull();
  expect(pendingBox!.y + pendingBox!.height).toBeLessThanOrEqual(liveBox!.y + 1);

  await textarea.fill("응답 중에 보내는 메시지");
  await expect(steerButton).toBeEnabled();
  await expect(page.locator(".composer-attach")).toBeVisible();
  await expectSingleComposerRow(page, 0.5);

  // Phone width: the attach button steps aside for the duration of the stream
  // (an image cannot be sent mid-turn anyway), so mic + steer + stop share the
  // row with a textarea that is still wide enough to read what is being typed.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(steerButton).toBeVisible();
  await expect(page.locator(".composer-attach")).toBeHidden();
  await expectSingleComposerRow(page, 0.45);
});
