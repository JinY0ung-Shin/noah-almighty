import { expect, test, type Page } from "@playwright/test";
import { CURRENT_RELEASE_ID } from "../../src/server/releaseNotes.js";

// 공용 MCP 서버: the admin panel's add (credential slot) → list → check → edit
// flow, and the 시크릿 card where a user connects ONE OF THEIR OWN secrets to a
// slot (the admin never names a secret). Behavior + layout (no screenshots compared).

const user = {
  id: "admin-1",
  username: "admin",
  displayName: "관리자",
  alias: "",
  bio: "",
  intro: "",
  hashtags: [],
  roles: ["admin"],
  groups: [],
  secretNames: ["MY_JIRA", "WIKI_KEY", "GITHUB_TOKEN"],
  shellExposedSecretNames: [],
  browserSecrets: [],
  experimentalFeatures: [],
  knowledgeRepo: null,
  gitTokenSet: false,
  onboardedAt: "2026-09-01",
  lastSeenRelease: CURRENT_RELEASE_ID,
};

type Slot = { id: string; label: string; header: string; format: string };
type Server = {
  name: string;
  label: string;
  description: string;
  url: string;
  transport: "http" | "sse";
  headers: Record<string, string>;
  secretSlots: Slot[];
  enabled: boolean;
  updatedAt: string;
  origin: string;
};

type UserSlot = { id: string; label: string; header: string; boundSecret: string | null; stale: boolean };

async function mock(page: Page, opts: { failBind?: boolean } = {}) {
  const servers: Server[] = [];
  const sent: unknown[] = [];
  const binds: { method: string; path: string; body: unknown }[] = [];
  const userServers = [
    {
      name: "jira",
      label: "사내 Jira",
      description: "이슈 검색과 수정",
      origin: "https://jira.example.com",
      slots: [{ id: "token", label: "API 토큰", header: "Authorization", boundSecret: null, stale: true }] as UserSlot[],
    },
    {
      name: "wiki",
      label: "위키",
      description: "",
      origin: "https://wiki.example.com",
      slots: [{ id: "key", label: "키", header: "X-Api-Key", boundSecret: "WIKI_KEY", stale: false }] as UserSlot[],
    },
    { name: "docs", label: "문서", description: "", origin: "https://docs.example.com", slots: [] as UserSlot[] },
  ];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let status = 200;
    let body: unknown = { requests: [], notifications: [], plugins: [], groups: [], skills: [] };
    if (path === "/api/bootstrap") body = { needsSetup: false, signupMode: "open", githubHost: "github.com" };
    else if (path === "/api/me") body = { user };
    else if (path === "/api/avatars") body = { avatars: [] };
    else if (path === "/api/conversations") body = { conversations: [] };
    else if (path === "/api/admin/stats") body = { stats: {} };
    else if (path === "/api/admin/users") body = { users: [] };
    else if (path === "/api/audit") body = { audit: [] };
    else if (path === "/api/admin/system") body = { system: { signupMode: "open", toolSkillPolicy: { disabledTools: [], disabledSkills: [] }, hexSshToolPolicy: { owner: [], trusted: [], colleague: [] } } };
    else if (path === "/api/admin/presence") body = { presence: { users: [], windowMinutes: 60 } };
    else if (path === "/api/admin/shared-mcp-servers" && request.method() === "POST") {
      const input = request.postDataJSON();
      sent.push(input);
      const server: Server = {
        ...input,
        label: input.label || input.name,
        secretSlots: input.secretSlots.map((slot: Partial<Slot>, i: number) => ({ id: slot.id || `s${i}`, ...slot })),
        updatedAt: "2026-10-26T00:00:00Z",
        origin: new URL(input.url).origin,
      };
      servers.push(server);
      body = { server };
    } else if (path === "/api/admin/shared-mcp-servers") body = { servers };
    else if (path.endsWith("/check")) body = { ok: true, tools: ["search_issues", "get_issue"], missingSecrets: [], error: null };
    else if (path === "/api/me/shared-mcp-servers") body = { servers: userServers };
    else if (path.startsWith("/api/me/shared-mcp-servers/")) {
      binds.push({ method: request.method(), path, body: request.postDataJSON() });
      if (opts.failBind) {
        status = 400;
        body = { error: "연결할 수 없는 시크릿입니다." };
      } else {
        const [, , , , name, , slotId] = path.split("/");
        const slot = userServers.find((s) => s.name === name)!.slots.find((s) => s.id === slotId)!;
        slot.boundSecret = request.method() === "PUT" ? request.postDataJSON().secretName : null;
        slot.stale = false;
        body = { servers: userServers };
      }
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { errors, sent, binds };
}

test("admin registers a shared MCP server with a credential slot and checks it", async ({ page }, testInfo) => {
  const { errors, sent } = await mock(page);
  await page.goto("/#/admin/mcp");
  await expect(page.getByRole("heading", { name: "공용 MCP 서버" })).toBeVisible();
  await expect(page.getByText("등록된 공용 MCP 서버가 없습니다.")).toBeVisible();

  await page.getByRole("button", { name: "추가" }).click();
  await page.getByLabel("서버 이름").fill("jira");
  await page.getByLabel("표시 이름").fill("사내 Jira");
  await page.getByLabel("서버 주소 (URL)").fill("https://jira.example.com/mcp");
  // A new server starts with the common Bearer slot prefilled.
  await expect(page.getByLabel("인증 자리 1 헤더")).toHaveValue("Authorization");
  await expect(page.getByLabel("인증 자리 1 형식")).toHaveValue("Bearer {secret}");
  await page.getByRole("button", { name: "고정 헤더 추가" }).click();
  // A fixed header repeating a slot's header (any case) blocks saving.
  await page.getByLabel("고정 헤더 1 이름").fill("authorization");
  await expect(page.getByText("authorization 헤더가 두 번 들어 있습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await page.getByLabel("고정 헤더 1 이름").fill("X-Team");
  await page.getByLabel("고정 헤더 1 값").fill("qa");
  await page.getByRole("button", { name: "저장", exact: true }).click();

  await expect(page.getByText("mcp__jira__*")).toBeVisible();
  await expect(page.locator(".tag", { hasText: "인증 자리 · API 토큰" })).toBeVisible();
  expect(sent).toEqual([
    {
      name: "jira",
      label: "사내 Jira",
      description: "",
      url: "https://jira.example.com/mcp",
      transport: "http",
      headers: { "X-Team": "qa" },
      secretSlots: [{ label: "API 토큰", header: "Authorization", format: "Bearer {secret}" }],
      enabled: true,
    },
  ]);
  await page.getByRole("button", { name: "연결 확인" }).click();
  await expect(page.getByText("연결됨 · 도구 2개: search_issues, get_issue")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("admin-shared-mcp.png"), fullPage: true });

  // Moving the host warns that every user's connection resets.
  await page.getByRole("button", { name: "편집" }).click();
  await expect(page.getByLabel("서버 이름")).toBeDisabled();
  await page.getByLabel("서버 주소 (URL)").fill("https://collector.example.net/mcp");
  await expect(page.getByText("저장하면 모든 사용자의 시크릿 연결이 해제되어", { exact: false })).toBeVisible();
  await page.getByLabel("서버 주소 (URL)").fill("https://jira.example.com/other");
  await expect(page.getByText("저장하면 모든 사용자의 시크릿 연결이 해제되어", { exact: false })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("admin-shared-mcp-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a user connects one of their own secrets to a slot in the 시크릿 card", async ({ page }, testInfo) => {
  const { errors, binds } = await mock(page);
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "권한·연결" }).click();
  const box = page.locator(".shared-mcp-secret-box");
  await expect(box.getByText("공용 MCP 서버에 연결할 시크릿")).toBeVisible();
  await expect(box.getByText("https://jira.example.com")).toBeVisible();
  // Servers that need no secret are not listed; a stale binding says so.
  await expect(box.getByText("문서")).toHaveCount(0);
  await expect(box.getByText("서버 주소가 바뀌어 연결이 해제됐어요.", { exact: false })).toBeVisible();
  const jira = box.getByLabel("사내 Jira API 토큰에 연결할 시크릿");
  await expect(jira).toHaveValue("");
  // Reserved git/SSH names are never offered.
  await expect(jira.locator("option")).toHaveText(["연결 안 함", "MY_JIRA", "WIKI_KEY"]);
  await expect(box.getByLabel("위키 키에 연결할 시크릿")).toHaveValue("WIKI_KEY");

  await jira.selectOption("MY_JIRA");
  await expect(page.getByText("MY_JIRA 시크릿을 사내 Jira에 연결했습니다.", { exact: false })).toBeVisible();
  await expect(box.getByText("서버 주소가 바뀌어 연결이 해제됐어요.", { exact: false })).toHaveCount(0);
  expect(binds).toEqual([{ method: "PUT", path: "/api/me/shared-mcp-servers/jira/slots/token", body: { secretName: "MY_JIRA" } }]);

  await box.getByLabel("위키 키에 연결할 시크릿").selectOption("");
  await expect(page.getByText("위키 연결을 해제했습니다.")).toBeVisible();
  expect(binds.at(-1)).toMatchObject({ method: "DELETE", path: "/api/me/shared-mcp-servers/wiki/slots/key" });

  await box.getByRole("button", { name: "이 서버용 시크릿 새로 추가" }).first().click();
  await expect(page.getByLabel("이름", { exact: true })).toHaveValue("JIRA_TOKEN");
  await expect(page.locator("#secret-extra-value")).toBeFocused();
  await box.screenshot({ path: testInfo.outputPath("secret-shared-mcp-box.png") });
  expect(errors).toEqual([]);
});

test("a rejected connection puts the picker back", async ({ page }) => {
  const { errors } = await mock(page, { failBind: true });
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "권한·연결" }).click();
  const jira = page.getByLabel("사내 Jira API 토큰에 연결할 시크릿");
  await jira.selectOption("MY_JIRA");
  await expect(page.getByText("연결 실패: 연결할 수 없는 시크릿입니다.")).toBeVisible();
  await expect(jira).toHaveValue("");
  expect(errors).toEqual([]);
});
