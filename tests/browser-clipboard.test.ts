import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import {
  stageClipboardImage,
  stageClipboardText,
  readStagedImage,
} from "../src/server/browserClipboard.js";
import { buildBrowserTools } from "../src/server/agent/browserTools.js";
import { requestOrigin, viewerPlatformFromUserAgent } from "../src/server/routes/_shared.js";
import type { AuthenticatedRequest } from "../src/server/auth.js";
import { callTool, signup, withTempDir } from "./helpers.js";

// Coverage target: src/server/browserClipboard.ts — the short-lived byte store
// behind copy_image (agent → OS clipboard) and the auth-gated staging routes the
// browser bridge drives — plus the two request-derived inputs copy_image is
// built from (`requestOrigin`, `viewerPlatformFromUserAgent`) and the tool
// handler that stitches them together. The clipboard WRITE itself is a browser
// fact proven by the Playwright spike, not something a server test can exercise.

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYHvqzS6AAAAAElFTkSuQmCC",
  "base64",
);

let tempDir: string;
const getTempDir = withTempDir("browser-clipboard", () => {
  tempDir = getTempDir();
});

function testApp() {
  const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
  return createApp(services);
}

/** Sign `username` up and return the agent plus the real user id it was given. */
async function signedUp(app: ReturnType<typeof testApp>, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, userId: res.body.user.id as string };
}

describe("clipboard staging store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips bytes + mime + owner and mints the contract path", () => {
    const { token, path } = stageClipboardImage(PNG_BYTES, "image/png", "user-a");
    expect(path).toBe("/browser-clip/" + token); // CONTRACT: copy_image builds appOrigin + path
    const got = readStagedImage(token);
    expect(got?.mime).toBe("image/png");
    expect(got?.bytes.equals(PNG_BYTES)).toBe(true);
    // The owner rides along so the routes can bind each read to one user.
    expect(got?.userId).toBe("user-a");
  });

  it("returns null for an unknown token", () => {
    expect(readStagedImage("deadbeef")).toBeNull();
  });

  it("evicts the oldest entries when the store is flooded", () => {
    const first = stageClipboardImage(PNG_BYTES, "image/png", "user-a").token;
    let last = first;
    for (let i = 0; i < 60; i += 1) {
      last = stageClipboardImage(PNG_BYTES, "image/png", "user-a").token;
    }
    // The cap is well under 60, so the earliest token must have been dropped
    // while the most recent survives.
    expect(readStagedImage(first)).toBeNull();
    expect(readStagedImage(last)).not.toBeNull();
  });

  it("drops an entry once its TTL passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { token } = stageClipboardImage(PNG_BYTES, "image/png", "user-a");
    expect(readStagedImage(token)).not.toBeNull();
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z")); // +5 min, past the ~2 min TTL
    expect(readStagedImage(token)).toBeNull();
  });

  it("round-trips TEXT through the same store, tagged so the staging page picks its text mode", () => {
    // copy_text adds no route and no wire op: it rides the image contract and
    // the served Content-Type is the ONLY thing that differs.
    const { token, path } = stageClipboardText("코드 <script>\nline 2", "user-a");
    expect(path).toBe("/browser-clip/" + token);
    const got = readStagedImage(token);
    expect(got?.mime).toBe("text/plain; charset=utf-8");
    expect(got?.bytes.toString("utf8")).toBe("코드 <script>\nline 2");
    expect(got?.userId).toBe("user-a");
  });

  it("refuses text over the staging byte cap instead of parking it for the TTL", () => {
    // Defense in depth behind copy_text's own character cap: multi-byte
    // characters mean a legal character count can still be megabytes of UTF-8.
    expect(() => stageClipboardText("가".repeat(400_000), "user-a")).toThrow(
      /clipboard staging limit/,
    );
    // Just under the cap still stages.
    expect(() => stageClipboardText("a".repeat(999_999), "user-a")).not.toThrow();
  });

  it("sweeps expired entries on a plain read, not only when something new is staged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const stale = stageClipboardImage(PNG_BYTES, "image/png", "user-a").token;
    const other = stageClipboardImage(PNG_BYTES, "image/png", "user-b").token;
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
    // Reading ONE token also reclaims the other expired entry's bytes — a
    // staging burst must not sit in memory until the next stage happens.
    expect(readStagedImage(stale)).toBeNull();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); // rewind: only eviction can have dropped it
    expect(readStagedImage(other)).toBeNull();
  });
});

describe("clipboard staging routes", () => {
  it("requires authentication for the page and the bytes", async () => {
    const app = testApp();
    const { token } = stageClipboardImage(PNG_BYTES, "image/png", "someone");
    await request(app).get(`/browser-clip/${token}`).expect(401);
    await request(app).get(`/browser-clip/${token}/img`).expect(401);
  });

  it("serves the staging page, the bytes, and the script to the viewer it was staged for", async () => {
    const app = testApp();
    const { agent, userId } = await signedUp(app, "clip-user");
    const { token } = stageClipboardImage(PNG_BYTES, "image/png", userId);

    const page = await agent.get(`/browser-clip/${token}`).expect(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.text).toContain("클립보드로 복사"); // the button label copy_image tells the agent to click
    expect(page.text).toContain("/browser-clip.js"); // external script (CSP forbids inline)

    const img = await agent.get(`/browser-clip/${token}/img`).expect(200);
    expect(img.headers["content-type"]).toContain("image/png");
    expect(img.headers["cache-control"]).toBe("no-store");

    const script = await agent.get(`/browser-clip.js`).expect(200);
    expect(script.headers["content-type"]).toContain("javascript");
    expect(script.text).toContain("navigator.clipboard");
    expect(script.text).toContain("ClipboardItem");
    // The document title is the machine-readable outcome the agent verifies
    // with list_tabs — both branches must be reachable from the script.
    expect(script.text).toContain("COPIED");
    expect(script.text).toContain("COPY_FAILED");
  });

  it("serves staged TEXT under its own content type, which is what puts the page in text mode", async () => {
    const app = testApp();
    const { agent, userId } = await signedUp(app, "clip-text-user");
    const { token } = stageClipboardText("# 제목\n본문 <b>x</b>", userId);

    const body = await agent.get(`/browser-clip/${token}/img`).expect(200);
    expect(body.headers["content-type"]).toContain("text/plain");
    expect(body.text).toBe("# 제목\n본문 <b>x</b>");

    // The page itself is payload-agnostic — one generic heading and one button
    // the agent clicks, whichever kind was staged.
    const page = await agent.get(`/browser-clip/${token}`).expect(200);
    expect(page.text).toContain("클립보드로 복사");
    expect(page.text).not.toContain("이미지를 클립보드로 복사");

    // The script must carry BOTH branches: the text write and the image write.
    const script = await agent.get("/browser-clip.js").expect(200);
    expect(script.text).toContain("navigator.clipboard.writeText");
    expect(script.text).toContain("ClipboardItem");
    expect(script.text).toContain('contentType.indexOf("text/")');
  });

  it("hides another user's staged TEXT behind the same 404 as an expired token", async () => {
    const app = testApp();
    const owner = await signedUp(app, "clip-text-owner");
    const stranger = await signedUp(app, "clip-text-stranger");
    const { token } = stageClipboardText("secret draft", owner.userId);

    // Same rule as an image: the token is printed into the persisted tool
    // result, so holding it must not be enough to read someone else's text.
    const expired = await stranger.agent.get("/browser-clip/deadbeef").expect(404);
    const foreign = await stranger.agent.get(`/browser-clip/${token}`).expect(404);
    expect(foreign.text).toBe(expired.text);
    const foreignBytes = await stranger.agent.get(`/browser-clip/${token}/img`).expect(404);
    expect(foreignBytes.text).not.toContain("secret draft");
    await owner.agent.get(`/browser-clip/${token}/img`).expect(200);
  });

  it("404s an unknown or expired token for an authed viewer", async () => {
    const app = testApp();
    const { agent } = await signedUp(app, "clip-user-2");
    await agent.get("/browser-clip/deadbeef/img").expect(404);
    await agent.get("/browser-clip/deadbeef").expect(404);
  });

  it("hides another user's staged image behind the SAME 404 as an expired one", async () => {
    const app = testApp();
    const owner = await signedUp(app, "clip-owner");
    const stranger = await signedUp(app, "clip-stranger");
    const { token } = stageClipboardImage(PNG_BYTES, "image/png", owner.userId);

    // The token is printed into the persisted tool-result text, so being logged
    // in and holding it must not be enough: the bytes can come from the owner's
    // private repo clone. The body must match the expired one exactly — a
    // different response would confirm the staging exists.
    const expired = await stranger.agent.get("/browser-clip/deadbeef").expect(404);
    const foreignPage = await stranger.agent.get(`/browser-clip/${token}`).expect(404);
    expect(foreignPage.text).toBe(expired.text);
    await stranger.agent.get(`/browser-clip/${token}/img`).expect(404);

    // ...and the owner is unaffected by the stranger's attempts.
    await owner.agent.get(`/browser-clip/${token}`).expect(200);
    await owner.agent.get(`/browser-clip/${token}/img`).expect(200);
  });

  it("hard-404s every other path under /browser-clip/, never the SPA fallback", async () => {
    const app = testApp();
    const { agent, userId } = await signedUp(app, "clip-namespace");
    const { token } = stageClipboardImage(PNG_BYTES, "image/png", userId);

    // The EXTENSION exempts /browser-clip/ token pages from its allowlist, so
    // this namespace must never serve the logged-in app UI: a deep path that
    // fell through to the SPA fallback would render Noah under an exempted URL.
    for (const path of [
      `/browser-clip/${token}/deeper`,
      `/browser-clip/${token}/img/extra`,
      "/browser-clip/x/y/z",
    ]) {
      const res = await agent.get(path).expect(404);
      expect(res.headers["content-type"]).toContain("text/plain");
      expect(res.text).not.toContain("<");
    }
  });
});

/** A request stub carrying just the headers `requestOrigin` reads. */
function stubReq(headers: Record<string, string>, protocol = "http"): AuthenticatedRequest {
  return {
    protocol,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as AuthenticatedRequest;
}

describe("request-derived browser inputs", () => {
  it("takes the FIRST forwarded host and proto, so a chained proxy can't malform the origin", () => {
    const origin = requestOrigin(
      stubReq({
        "x-forwarded-host": "noah.corp.example, internal.svc",
        "x-forwarded-proto": "https",
        host: "internal.svc:8080",
      }),
    );
    expect(origin).toBe("https://noah.corp.example");
  });

  it("normalizes the parsed origin (default port dropped, host lowercased)", () => {
    expect(requestOrigin(stubReq({ host: "noah.example:443" }, "https"))).toBe("https://noah.example");
    expect(requestOrigin(stubReq({ host: "NOAH.Example" }, "https"))).toBe("https://noah.example");
    // A non-default port is part of the origin and must survive.
    expect(requestOrigin(stubReq({ host: "noah.example:8443" }, "https"))).toBe(
      "https://noah.example:8443",
    );
  });

  it("fails CLOSED on anything that isn't a plain http(s) origin", () => {
    // These headers are client-controlled; a forged one would otherwise hand the
    // agent an attacker-chosen origin to open in the user's own browser.
    expect(requestOrigin(stubReq({ host: "exa mple" }))).toBeNull();
    expect(requestOrigin(stubReq({ host: "noah.example", "x-forwarded-proto": "javascript" }))).toBeNull();
    expect(requestOrigin(stubReq({ host: "noah.example", "x-forwarded-proto": "file" }))).toBeNull();
    expect(requestOrigin(stubReq({}))).toBeNull(); // no host header at all
    expect(requestOrigin(stubReq({ "x-forwarded-host": " , internal.svc" }))).toBeNull();
    // A scheme carrying its own authority parses as `https:` with the ATTACKER's
    // host, so the proto is validated before it is ever concatenated.
    expect(
      requestOrigin(stubReq({ host: "noah.example", "x-forwarded-proto": "https://evil.example" })),
    ).toBeNull();
  });

  it("reads the driven browser's OS off the chat request's User-Agent", () => {
    expect(
      viewerPlatformFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      ),
    ).toBe("mac");
    expect(
      viewerPlatformFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      ),
    ).toBe("windows");
    expect(
      viewerPlatformFromUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0"),
    ).toBe("linux");
    // Unknown stays undefined so the tool text mentions BOTH shortcuts rather
    // than guessing one that pastes nothing.
    expect(viewerPlatformFromUserAgent(undefined)).toBeUndefined();
    expect(viewerPlatformFromUserAgent("")).toBeUndefined();
    expect(viewerPlatformFromUserAgent("curl/8.4.0")).toBeUndefined();
  });
});

describe("clipboard tool handler, action \"image\"", () => {
  const execute = () =>
    vi.fn(async () => ({ behavior: "ok" as const, url: "https://intra.example/x", title: "T" }));
  const stage = () => vi.fn(async () => ({ path: "/browser-clip/abc123" }));

  function description(tools: readonly { name: string; description?: string }[]): string {
    const found = tools.find((t) => t.name === "clipboard");
    if (!found) throw new Error("clipboard tool not found");
    return found.description ?? "";
  }

  it("refuses an uncleared viewer without staging anything", async () => {
    const stageClipboardImage = stage();
    const tools = buildBrowserTools({
      execute: execute(),
      allowed: false,
      appOrigin: "https://noah.example",
      stageClipboardImage,
    });
    const res = await callTool(tools, "clipboard", { action: "image", path: "shot.png" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("talking to their OWN avatar");
    expect(stageClipboardImage).not.toHaveBeenCalled();
  });

  it("refuses when the run has no app origin or no stager", async () => {
    const noStager = await callTool(
      buildBrowserTools({ execute: execute(), allowed: true, appOrigin: "https://noah.example" }),
      "clipboard",
      { action: "image", path: "shot.png" },
    );
    expect(noStager.isError).toBe(true);
    expect(noStager.content[0].text).toContain("not available in this run");
    // A dead end must redirect (root CLAUDE.md): the way that still works is
    // handing the image to the user for a manual copy.
    expect(noStager.content[0].text).toContain("mcp__file_output__show_file");

    const noOrigin = await callTool(
      buildBrowserTools({ execute: execute(), allowed: true, stageClipboardImage: stage() }),
      "clipboard",
      { action: "image", path: "shot.png" },
    );
    expect(noOrigin.isError).toBe(true);
    expect(noOrigin.content[0].text).toContain("not available in this run");
    expect(noOrigin.content[0].text).toContain("mcp__file_output__show_file");
  });

  it("returns the absolute staging URL and drives the paste off the COPIED click result", async () => {
    const stageClipboardImage = stage();
    const tools = buildBrowserTools({
      execute: execute(),
      allowed: true,
      appOrigin: "https://noah.example",
      stageClipboardImage,
      viewerPlatform: "mac",
    });
    const res = await callTool(tools, "clipboard", { action: "image", path: "shot.png" });
    expect(res.isError).toBeFalsy();
    expect(stageClipboardImage).toHaveBeenCalledWith("shot.png");

    const body = res.content[0].text;
    expect(body).toContain("https://noah.example/browser-clip/abc123");
    // The copy can silently fail, so success text and description both route the
    // agent through the title the CLICK reports instead of assuming the
    // clipboard is set — no list_tabs round trip, since the click result
    // already carries that title.
    expect(body).toContain("COPIED");
    expect(body).toContain("COPY_FAILED");
    expect(body).not.toContain("VERIFY with mcp__browser__list_tabs");
    // Both extension generations ride this one text: 0.27.0+ closes the COPIED
    // staging tab and re-points the working tab, an older install does not, and
    // the tool cannot tell which one the viewer has installed.
    expect(body).toContain("CLOSES the staging tab itself");
    expect(body).toContain('mcp__browser__tabs action "select" back to your target page and action "close" on the staging tab');
    expect(body).toContain('open this URL with mcp__browser__tabs action "new"');
    // The description keeps only the call-time guard; the step-by-step flow is
    // in this result and in manual topic `browser-operations`.
    expect(description(tools)).toContain("paste ONLY when that click's result says COPIED (never on COPY_FAILED)");
    expect(description(tools)).toContain("manual topic `browser-operations`");
    expect(description(tools)).not.toMatch(/\b(list_tabs|new_tab|select_tab|close_tab|copy_image|copy_text)\b/);
    // Ctrl+V is not paste on macOS; a hardcoded ["Control"] would paste nothing.
    expect(body).toContain('["Meta"]');
    expect(body).not.toContain('["Control"]');
  });

  it("names the Control modifier on Windows and both when the OS is unknown", async () => {
    const win = await callTool(
      buildBrowserTools({
        execute: execute(),
        allowed: true,
        appOrigin: "https://noah.example",
        stageClipboardImage: stage(),
        viewerPlatform: "windows",
      }),
      "clipboard",
      { action: "image", path: "shot.png" },
    );
    expect(win.content[0].text).toContain('["Control"]');
    expect(win.content[0].text).not.toContain('["Meta"]');

    const unknown = await callTool(
      buildBrowserTools({
        execute: execute(),
        allowed: true,
        appOrigin: "https://noah.example",
        stageClipboardImage: stage(),
      }),
      "clipboard",
      { action: "image", path: "shot.png" },
    );
    expect(unknown.content[0].text).toContain('["Control"]');
    expect(unknown.content[0].text).toContain('["Meta"]');
  });

  it("redirects an unknown action or a missing argument without staging anything", async () => {
    const stageClipboardImage = stage();
    const stageClipboardText = stage();
    const tools = buildBrowserTools({
      execute: execute(),
      allowed: true,
      appOrigin: "https://noah.example",
      stageClipboardImage,
      stageClipboardText,
    });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "png", path: "shot.png" }, 'Unknown action "png" for mcp__browser__clipboard. Use "image" (with `path`) or "text" (with `text`).'],
      [{ action: "image" }, 'mcp__browser__clipboard action "image" needs `path`'],
      [{ action: "text" }, 'mcp__browser__clipboard action "text" needs `text`'],
    ];
    for (const [args, message] of cases) {
      const res = await callTool(tools, "clipboard", args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(res.content[0].text).toContain(message);
    }
    expect(stageClipboardImage).not.toHaveBeenCalled();
    expect(stageClipboardText).not.toHaveBeenCalled();
  });

  it("reports a staging failure as a tool error instead of a staging URL", async () => {
    const tools = buildBrowserTools({
      execute: execute(),
      allowed: true,
      appOrigin: "https://noah.example",
      stageClipboardImage: vi.fn(async () => {
        throw new Error("The image file does not exist.");
      }),
    });
    const res = await callTool(tools, "clipboard", { action: "image", path: "missing.png" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("The image file does not exist.");
  });
});
