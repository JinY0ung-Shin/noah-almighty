import { expect, test, type Page } from "@playwright/test";

import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// A blocking canvas is PARKED on conversation c-park (the run is alive
// server-side). Leaving and returning must replay the run's event log and bring
// the selection buttons back — every time, not just the first — and the canvas
// must stay reachable once the conversation is one pane of a split.

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

const RUN_ID = "run-park";

function sse(frames: Array<{ id: number; event: string; data: unknown }>): string {
  return frames
    .map((f) => `id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`)
    .join("");
}

const replayBody = sse([
  { id: 1, event: "open", data: { conversationId: "c-park", avatarId: "user-1", runId: RUN_ID } },
  { id: 2, event: "status", data: { label: "실행 중: 캔버스 표시" } },
  {
    id: 3,
    event: "canvas",
    data: {
      runId: RUN_ID,
      requestId: "rq-park",
      artifactId: "cv-park",
      title: "옵션을 골라주세요",
      content: "다음 중 하나를 고르세요.",
      contentType: "markdown",
      controls: [
        {
          type: "buttons",
          id: "pick",
          label: "선택",
          options: [{ label: "옵션 A" }, { label: "옵션 B" }],
        },
      ],
      interaction: "blocking",
      editable: false,
    },
  },
]);

// Flipped to true mid-test: models the park having STARTED while the user was
// inside c-park on a live send (no sidebar-busy lock in that flow).
let parkActive = false;

async function mockApp(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === `/api/chat/runs/${RUN_ID}/events`) {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: replayBody,
      });
      return;
    }
    let body: Record<string, unknown> = {};
    if (path === "/api/bootstrap") {
      body = { needsSetup: false, githubHost: "github.com", signupMode: "open", confluenceConfigured: false };
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
          persona: "",
          isOwn: true,
          elevated: true,
          plugins: [],
        },
      };
    } else if (path === "/api/conversations") {
      body = {
        conversations: [
          {
            id: "c-park",
            avatarUserId: "user-1",
            title: "질문 대화",
            avatarDisplayName: "진영",
            updatedAt: "2026-08-11T03:00:00.000Z",
            isRoutine: false,
            routineId: null,
            routinePrompt: null,
          },
          {
            id: "c-other",
            avatarUserId: "user-1",
            title: "다른 대화",
            avatarDisplayName: "진영",
            updatedAt: "2026-08-11T02:00:00.000Z",
            isRoutine: false,
            routineId: null,
            routinePrompt: null,
          },
        ],
      };
    } else if (path === "/api/messages") {
      const conv = url.searchParams.get("conversationId");
      body = {
        messages: [
          {
            id: `m-${conv}`,
            conversationId: conv,
            role: "user",
            content: conv === "c-park" ? "옵션을 물어봐줘" : "안녕",
            response: null,
            createdAt: "2026-08-11T03:00:00.000Z",
          },
        ],
        groupKnowledgeOff: [],
        canvases: [],
      };
    } else if (path === "/api/chat/runs") {
      const conv = url.searchParams.get("conversationId");
      body =
        conv === "c-park" && parkActive
          ? {
              run: {
                runId: RUN_ID,
                conversationId: "c-park",
                avatarId: "user-1",
                eventCount: 3,
                pendingCount: 1,
                cancelled: false,
                background: false,
                backgroundTasks: 0,
              },
            }
          : { run: null };
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

test("parked canvas selection buttons survive leaving and returning to the conversation", async ({ page }) => {
  await mockApp(page);
  await page.goto(`${process.env.REPRO_BASE_URL || ""}/`);
  await expect(page.getByRole("heading", { name: "탐색" })).toBeVisible();

  // 1. Open c-park BEFORE any park exists (models the user simply being in the
  //    conversation; the later live send that parks the canvas holds no
  //    sidebar-busy lock, so this open must resolve and unlock).
  await page.getByRole("button", { name: "대화 열기: 질문 대화" }).click();
  await expect(page.getByText("옵션을 물어봐줘")).toBeVisible();

  // The canvas ask begins while the user is inside (run now parked server-side).
  parkActive = true;

  // 2. Switch to another conversation.
  await page.getByRole("button", { name: "대화 열기: 다른 대화" }).click();
  await expect(page.getByText("안녕").first()).toBeVisible();

  // 3. Return: reattach + replay must restore the canvas selection buttons.
  await page.getByRole("button", { name: "대화 열기: 질문 대화" }).click();
  await expect(page.locator(".canvas-card .canvas-title", { hasText: "옵션을 골라주세요" })).toBeVisible();
  await expect(page.getByRole("button", { name: "옵션 A" })).toBeVisible();

  // 4. The open must RELEASE the sidebar's per-conversation busy lock. It used to
  //    await the reattach, which resolves only when the RUN ends — so this button
  //    stayed disabled for the whole park and every later click silently no-opped.
  await expect(page.getByRole("button", { name: "대화 열기: 질문 대화" })).toBeEnabled();

  // 5. Leave and return a SECOND time: the round trip has to keep working.
  await page.getByRole("button", { name: "대화 열기: 다른 대화" }).click();
  await expect(page.getByText("안녕").first()).toBeVisible();
  await page.getByRole("button", { name: "대화 열기: 질문 대화" }).click();
  await expect(page.locator(".canvas-card .canvas-title", { hasText: "옵션을 골라주세요" })).toBeVisible();
  await expect(page.getByRole("button", { name: "옵션 A" })).toBeVisible();

  // 6. Split view: the side-panel slot follows the ACTIVE pane. Adding c-other
  //    focuses it (no canvas of its own), and focusing the parked pane back must
  //    bring the canvas panel — which split mode used to render nowhere at all.
  // `.conv-acts` is display:none until the row is hovered/focused/active, and the
  // active row here is c-park — so hover c-other's row to reveal its split button.
  await page.getByRole("button", { name: "대화 열기: 다른 대화" }).hover();
  await page.getByRole("button", { name: "분할 대화에 추가: 다른 대화" }).click();
  await expect(page.getByRole("heading", { name: "분할 대화" })).toBeVisible();
  await expect(page.getByRole("button", { name: "옵션 A" })).toBeHidden();

  await page.getByRole("button", { name: "대화 1" }).click();
  await expect(page.locator(".canvas-card .canvas-title", { hasText: "옵션을 골라주세요" })).toBeVisible();
  await expect(page.getByRole("button", { name: "옵션 A" })).toBeVisible();
});
