import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";

// The 0.29.0 browser ops against the REAL extension: Playwright's Chromium loads
// the unpacked `extension/` folder (the shipped files, key-pinned id) and a local
// "Noah" page sends ops exactly the way client lib/chat.ts does —
// chrome.runtime.sendMessage(EXTENSION_ID, {source: "noah", …}) — so every op
// crosses the real externally_connectable gate, the real CDP_ALLOWLIST and the
// real chrome.debugger transport (the DOMStorage lesson in contract.md: Chrome
// facts are pinned on the transport the extension actually uses).
//
// Fixture origins: the "Noah" page and the allowed data pages are on
// `localhost:<port>`. Measured here (Chromium 1234): externally_connectable DOES
// match the port — a page on a random localhost port gets no chrome.runtime —
// so the extension is loaded from a temp COPY whose manifest adds exactly that
// one origin; every other byte is the shipped folder (the key, so the id, too).
// `outside.test` is mapped to 127.0.0.1 and is NOT on the allowlist, so it is
// the redirect target read_url must refuse BEFORE requesting it — which the
// server checks by recording every path it served.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/inspect-ops.spec.ts`
// (npx playwright is broken here; no dev server needed).

const EXTENSION_ID = "gdaheigeedlnhagpmokpmocahgieiobc";
const extensionDir = () => path.resolve(path.dirname(test.info().file), "../..", "extension");

type Reply = Record<string, unknown> & { ok: boolean; message?: string };

let server: http.Server;
let port = 0;
const served: string[] = [];

const PAGE_HTML = `<!doctype html><html><head><title>Fixture</title></head><body>
<h1>설정</h1>
<button id="save">저장하기</button>
<button id="del">삭제</button>
<a href="/repos">저장소 목록</a>
<label>검색 <input id="q" type="text"></label>
<label><input type="checkbox" id="agree"> 동의</label>
<p>저장 버튼을 누르세요</p>
<p id="out"></p>
<script>
  document.getElementById("save").addEventListener("click", () => {
    document.getElementById("out").textContent = "saved:" + document.getElementById("q").value;
    console.log("clicked save with token Bearer abcdefghijklmnop1234567890");
    console.error("save failed for key 0123456789abcdef0123456789abcdef");
    fetch("/api/ping?secret=1").catch(() => {});
  });
  console.warn("page loaded");
</script>
</body></html>`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    served.push(`${req.headers.host?.split(":")[0]}${url.pathname}`);
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": type, ...extra });
      res.end(body);
    };
    switch (url.pathname) {
      case "/noah":
        return send(200, "text/html", "<!doctype html><title>Noah</title><p>noah</p>");
      case "/page.html":
        return send(200, "text/html; charset=utf-8", PAGE_HTML);
      case "/data.json":
        return send(200, "application/json", JSON.stringify({ items: [{ id: 1, name: "한글" }] }));
      case "/euc.txt":
        return send(200, "text/plain; charset=euc-kr", Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]));
      case "/redir-in":
        return send(302, "text/plain", "", { Location: "/data.json" });
      case "/redir-out":
        return send(302, "text/plain", "", { Location: `http://outside.test:${port}/secret` });
      case "/secret":
        return send(200, "text/plain", "outside secret");
      case "/image.png":
        return send(200, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
      case "/api/ping":
        return send(200, "application/json", "{}");
      default:
        return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function launch(): Promise<{ context: BrowserContext; noah: Page; worker: Worker; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-inspect-"));
  const ext = path.join(dir, "extension");
  fs.cpSync(extensionDir(), ext, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  manifest.externally_connectable.matches.push(`http://localhost:${port}/*`);
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(path.join(dir, "profile"), {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      "--host-resolver-rules=MAP *.test 127.0.0.1",
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  expect(worker.url()).toContain(EXTENSION_ID);
  const noah = await context.newPage();
  await noah.goto(`http://localhost:${port}/noah`);
  return { context, noah, worker, dir };
}

let requestSeq = 0;

/**
 * One op, sent exactly like the Noah client sends it — WITH a fresh requestId.
 * Without one the extension coalesces identical payloads sent within 1.5 s
 * (performCoalesced's twin-tab dedupe), so a second identical read would be
 * handed the first one's reply instead of running.
 */
function op(noah: Page, message: Record<string, unknown>): Promise<Reply> {
  const withId = { requestId: `test-${Date.now()}-${++requestSeq}`, ...message };
  return noah.evaluate(
    ([id, msg]) =>
      new Promise<Reply>((resolve) => {
        const rt = (globalThis as unknown as {
          chrome: { runtime: { sendMessage: (id: string, m: unknown, cb: (r: Reply) => void) => void } };
        }).chrome.runtime;
        rt.sendMessage(id as string, { source: "noah", ...(msg as object) }, (reply) => resolve(reply));
      }),
    [EXTENSION_ID, withId] as const,
  );
}

/** A Noah group holding the fixture page, made from the worker (no consent popup to click). */
async function groupFixture(worker: Worker): Promise<void> {
  await worker.evaluate(async (url) => {
    const c = (globalThis as unknown as { chrome: any }).chrome;
    const tab = await c.tabs.create({ url, active: true });
    const groupId = await c.tabs.group({ tabIds: [tab.id] });
    await c.tabGroups.update(groupId, { title: "Noah" });
    await new Promise((r) => setTimeout(r, 800));
  }, `http://localhost:${port}/page.html`);
}

/**
 * Send an op that raises the data-consent popup, and answer it the way the user
 * would: the popup is the extension's own consent.html window.
 */
async function opWithConsent(
  context: BrowserContext,
  noah: Page,
  message: Record<string, unknown>,
  allow = true,
): Promise<{ reply: Reply; kind: string }> {
  const seen = new Set(context.pages());
  const pending = op(noah, message);
  // The popup is a chrome.windows.create window; its page may surface before its
  // URL is set, so poll the context's pages instead of filtering the event.
  let consent: Page | undefined;
  for (let i = 0; i < 100 && !consent; i += 1) {
    consent = context.pages().find((page) => !seen.has(page) && page.url().includes("consent.html"));
    if (!consent) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!consent) throw new Error(`no consent popup appeared; pages: ${context.pages().map((p) => p.url()).join(", ")}`);
  await consent.waitForLoadState();
  const kind = new URL(consent.url()).searchParams.get("kind") || "";
  await consent.click(allow ? "#allow" : "#deny");
  return { reply: await pending, kind };
}
test.describe("0.29.0 browser ops in the real extension", () => {
  test.setTimeout(90_000);

  test("version, find and read_url (incl. redirect-out and non-text refusals)", async () => {
    const { context, noah, worker, dir } = await launch();
    try {
      const config = await op(noah, { op: "setAllowedOrigins", patterns: ["localhost"] });
      expect(config.ok).toBe(true);
      const probe = await op(noah, { op: "getAllowedOrigins" });
      expect(probe.version).toBe("0.29.0");
      await groupFixture(worker);

      // find: the same uids a snapshot prints, filtered.
      const found = await op(noah, { op: "find", name: "저장" });
      expect(found.ok, found.message).toBe(true);
      expect(String(found.snapshot)).toMatch(/\[e\d+\] button "저장하기"/);
      expect(String(found.snapshot)).toMatch(/\[e\d+\] link "저장소 목록"/);
      expect(String(found.note)).toContain("2 elements matched");
      const button = /\[(e\d+)\] button "저장하기"/.exec(String(found.snapshot))![1];
      const snap = await op(noah, { op: "snapshot" });
      expect(String(snap.snapshot)).toContain(`[${button}] button "저장하기"`);
      const none = await op(noah, { op: "find", role: "button", name: "없는버튼" });
      expect(none.ok).toBe(true);
      expect(String(none.note)).toContain("No element with a uid matched");

      // read_url: JSON pretty-printed, the working tab untouched.
      const tabsBefore = await op(noah, { op: "list_tabs" });
      const json = await op(noah, { op: "read_url", url: `http://localhost:${port}/data.json` });
      expect(json.ok, json.message).toBe(true);
      expect(json.fetchStatus).toBe(200);
      expect(json.fetchContentType).toBe("application/json");
      expect(json.fetchBody).toBe(JSON.stringify({ items: [{ id: 1, name: "한글" }] }, null, 2));
      expect(json.url).toBeUndefined();
      const tabsAfter = await op(noah, { op: "list_tabs" });
      expect((tabsAfter.tabs as unknown[]).length).toBe((tabsBefore.tabs as unknown[]).length);

      // An allowed redirect is followed, each hop judged.
      const redirected = await op(noah, { op: "read_url", url: `http://localhost:${port}/redir-in` });
      expect(redirected.ok, redirected.message).toBe(true);
      expect(String(redirected.fetchUrl)).toBe(`http://localhost:${port}/data.json`);
      expect(redirected.fetchHops).toBe(2);

      // A charset other than UTF-8 is decoded as declared.
      const euc = await op(noah, { op: "read_url", url: `http://localhost:${port}/euc.txt` });
      expect(euc.fetchBody).toBe("한글");

      // Positive control for the two refusals below: outside.test DOES resolve to
      // this server, so "never served" means "never requested", not "unreachable".
      served.length = 0;
      await noah.evaluate((u) => fetch(u, { mode: "no-cors" }).then(() => true, () => false), `http://outside.test:${port}/secret`);
      expect(served).toContain("outside.test/secret");

      // A redirect OUT of the allowlist is refused before the hop is requested.
      served.length = 0;
      const out = await op(noah, { op: "read_url", url: `http://localhost:${port}/redir-out` });
      expect(out.ok).toBe(false);
      expect(String(out.message)).toContain("REDIRECTED");
      expect(served).not.toContain("outside.test/secret");

      // A URL that is itself off the allowlist never leaves the browser.
      const direct = await op(noah, { op: "read_url", url: `http://outside.test:${port}/secret` });
      expect(direct.ok).toBe(false);
      expect(served).not.toContain("outside.test/secret");

      // A non-text body is refused unread.
      const image = await op(noah, { op: "read_url", url: `http://localhost:${port}/image.png` });
      expect(image.ok).toBe(false);
      expect(String(image.message)).toContain("not text");
    } finally {
      await context.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read_console: consent per site, capture from the approved read, redaction, revoke", async () => {
    const { context, noah, worker, dir } = await launch();
    try {
      await op(noah, { op: "setAllowedOrigins", patterns: ["localhost"] });
      await groupFixture(worker);

      // Declined: nothing captured, and the refusal is not a retry invitation.
      const declined = await opWithConsent(context, noah, { op: "read_console" }, false);
      expect(declined.kind).toBe("console");
      expect(declined.reply.ok).toBe(false);
      expect(String(declined.reply.message)).toContain("declined");

      // Approved: the capture starts NOW, and Chrome's own buffer for the current
      // document is replayed — the page's load-time warn predates the arm.
      const first = await opWithConsent(context, noah, { op: "read_console" });
      expect(first.reply.ok, first.reply.message).toBe(true);
      expect(String(first.reply.note)).toContain("started NOW");
      const loaded = (first.reply.consoleEntries as { level: string; text: string }[]).map((e) => `${e.level}:${e.text}`);
      // Measured (Chromium 1234): Runtime.enable replays V8's buffered console
      // messages of the current document, so a warn logged at page load —
      // before any consent existed — is in the first approved read.
      expect(loaded).toContain("warning:page loaded");

      // Live messages after an action, with token-shaped strings masked. The
      // grant is remembered, so no popup this time.
      const found = await op(noah, { op: "find", role: "button", name: "저장하기" });
      const uid = /\[(e\d+)\]/.exec(String(found.snapshot))![1];
      await op(noah, { op: "click", uid, maxChars: 500 });
      const second = await op(noah, { op: "read_console" });
      expect(second.ok, second.message).toBe(true);
      const texts = (second.consoleEntries as { level: string; text: string; source: string }[]).map((e) => e.text);
      expect(texts.some((t) => t.includes("clicked save with token Bearer [REDACTED]"))).toBe(true);
      expect(texts.some((t) => t.includes("[REDACTED_HEX]"))).toBe(true);
      expect(JSON.stringify(second.consoleEntries)).not.toContain("abcdefghijklmnop1234567890");
      expect(JSON.stringify(second.consoleEntries)).not.toContain("0123456789abcdef0123456789abcdef");

      // Revoking the grant (the options page's 취소) stops and clears the capture,
      // so the next read prompts again.
      await worker.evaluate(async () => {
        const c = (globalThis as unknown as { chrome: any }).chrome;
        await c.storage.session.remove("dataConsentGrants");
      });
      const again = await opWithConsent(context, noah, { op: "read_console" });
      expect(again.kind).toBe("console");
      expect(String(again.reply.note)).toContain("started NOW");
    } finally {
      await context.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read_network: its own consent, empty first read, then query-free rows", async () => {
    const { context, noah, worker, dir } = await launch();
    try {
      await op(noah, { op: "setAllowedOrigins", patterns: ["localhost"] });
      await groupFixture(worker);
      const first = await opWithConsent(context, noah, { op: "read_network" });
      expect(first.kind).toBe("network");
      expect(first.reply.ok, first.reply.message).toBe(true);
      expect(String(first.reply.note)).toContain("started NOW");
      // Approving the network list did not approve the console.
      const consoleAsk = await opWithConsent(context, noah, { op: "read_console" }, false);
      expect(consoleAsk.kind).toBe("console");

      const found = await op(noah, { op: "find", role: "button", name: "저장하기" });
      const uid = /\[(e\d+)\]/.exec(String(found.snapshot))![1];
      await op(noah, { op: "click", uid, maxChars: 500 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const second = await op(noah, { op: "read_network" });
      expect(second.ok, second.message).toBe(true);
      const rows = second.networkEntries as { method: string; url: string; status: number; type: string }[];
      const ping = rows.find((row) => row.url.endsWith("/api/ping"));
      expect(ping, JSON.stringify(rows)).toBeTruthy();
      expect(ping).toMatchObject({ method: "GET", status: 200, url: `http://localhost:${port}/api/ping` });
      expect(JSON.stringify(rows)).not.toContain("secret=1");
    } finally {
      await context.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
