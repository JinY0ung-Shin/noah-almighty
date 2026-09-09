import { expect, test } from "@playwright/test";
import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";
const admin = {
  id: "user-1",
  username: "jinyoung",
  displayName: "김진영",
  alias: "진영",
  bio: "",
  intro: "",
  hashtags: [],
  roles: ["admin"],
  onboardedAt: "2026-07-01T00:00:00.000Z",
  // An unseen release opens the what's-new modal, whose overlay eats every click.
  lastSeenRelease: CURRENT_RELEASE_ID,
  knowledgeRepo: null,
  gitTokenSet: false,
  secretNames: [],
  groups: [],
};


for (const mobile of [false, true]) {
  test(`DM sends plain text, retains drafts and shows new messages (${mobile ? "mobile" : "desktop"})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    let unread = 1;
    let reads = 0;
    let sentNonce = "";
    const messages = [{ id: 1, senderId: "peer", recipientId: admin.id, text: "안녕하세요", createdAt: new Date().toISOString() }];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      let body: unknown = {};
      if (path === "/api/bootstrap") body = { needsSetup: false, githubHost: "github.com", signupMode: "open" };
      else if (path === "/api/me") body = { user: { ...admin, roles: [] } };
      else if (path === "/api/avatars") body = { avatars: [{ ...admin, hasImage: false }] };
      else if (path === "/api/conversations") body = { conversations: [] };
      else if (path.endsWith("/knowledge/requests")) body = { requests: [] };
      else if (path.endsWith("/notifications")) body = { notifications: [] };
      else if (path.endsWith("/plugins")) body = { plugins: [] };
      else if (path === "/api/dm") body = { unread, windowMinutes: 60, peers: [
        { id: "peer", username: "minji", displayName: "이민지", online: true, available: true, unread },
        { id: "other", username: "other", displayName: "다른 사용자", online: false, available: true, unread: 0 },
      ] };
      else if (path.endsWith("/read")) { unread = 0; reads++; body = { ok: true }; }
      else if (path === "/api/dm/peer" && method === "POST") {
        const { text, nonce } = route.request().postDataJSON();
        if (sentNonce) {
          expect(nonce).toBe(sentNonce);
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: messages[1] }) });
          return;
        }
        sentNonce = nonce;
        const message = { id: messages.length + 1, senderId: admin.id, recipientId: "peer", text, createdAt: new Date().toISOString() };
        messages.push(message);
        await route.abort("failed"); return;
      } else if (path === "/api/dm/peer") body = { messages, hasMore: false };
      else if (path === "/api/dm/other") body = { messages: [], hasMore: false };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.addInitScript(() => { Object.defineProperty(crypto, "randomUUID", { value: undefined }); });
    await page.goto("/");
    if (mobile) await page.locator(".rail-toggle").click();
    await page.getByRole("button", { name: /DM.*1/ }).click();
    const dialog = page.getByRole("dialog", { name: "다이렉트 메시지" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /이민지/ }).click();
    await expect(dialog.getByText("안녕하세요", { exact: true })).toBeVisible();
    await expect.poll(() => reads).toBeGreaterThan(0);
    const composer = dialog.getByRole("textbox", { name: "DM 메시지 입력" });
    await composer.fill("보존할 초안");
    await dialog.getByRole("button", { name: /다른 사용자/ }).click();
    await expect(composer).toHaveValue("");
    await dialog.getByRole("button", { name: /이민지/ }).click();
    await expect(composer).toHaveValue("보존할 초안");
    await composer.fill("<img src=x onerror=alert(1)> 직접 답장");
    await composer.press("Enter");
    await expect(dialog.getByRole("alert")).toContainText("서버에 연결할 수 없습니다");
    await expect(composer).toHaveValue("<img src=x onerror=alert(1)> 직접 답장");
    await dialog.getByRole("button", { name: "보내기", exact: true }).click();
    await expect(dialog.getByText("<img src=x onerror=alert(1)> 직접 답장", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("");
    expect(messages).toHaveLength(2);
    await expect(dialog.locator(".dm-message img")).toHaveCount(0);
    messages.push({ id: 3, senderId: "peer", recipientId: admin.id, text: "실시간 답장", createdAt: new Date().toISOString() });
    await expect(dialog.getByText("실시간 답장", { exact: true })).toBeVisible({ timeout: 10000 });
    const overflow = await dialog.evaluate(el => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(errors).toEqual([]);
  });
}
