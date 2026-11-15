import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";

// Per-conversation working tabs + tab leases (extension 0.29.0) against the REAL
// extension: Playwright's Chromium loads the unpacked `extension/` folder and a
// local "Noah" page sends ops exactly like client lib/chat.ts does — each with a
// fresh requestId and the server-stamped `driver` (two conversations, A and B).
// Same harness as inspect-ops.spec.ts: the extension is loaded from a temp COPY
// whose manifest adds this server's localhost:<port> to externally_connectable
// (it matches the port); every other byte is the shipped folder.
//
// The grace is the real 60 s (TAB_LEASE_GRACE_MS), waited out for real once —
// the point is to prove the shipped value, not a test knob.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/tab-leases.spec.ts`
// (no dev server needed).

const EXTENSION_ID = "gdaheigeedlnhagpmokpmocahgieiobc";
const extensionDir = () => path.resolve(path.dirname(test.info().file), "../..", "extension");

type Tab = { tabId: string; title: string; url: string; current: boolean; busy?: boolean };
type Reply = Record<string, unknown> & { ok: boolean; message?: string; tabs?: Tab[]; url?: string };

let server: http.Server;
let port = 0;

const PAGE_HTML = (label: string) => `<!doctype html><html><head><title>${label}</title></head><body>
<h1>${label}</h1>
<label>검색 <input id="q" type="text"></label>
<button id="go">확인</button>
</body></html>`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    if (url.pathname === "/noah") {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("<!doctype html><title>Noah</title><p>noah</p>");
    }
    const page = /^\/page-([a-z]+)\.html$/.exec(url.pathname);
    if (page) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE_HTML(`page ${page[1]}`));
    }
    if (url.pathname === "/data.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end('{"ok":true}');
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function launch(): Promise<{ context: BrowserContext; noah: Page; worker: Worker; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-leases-"));
  const ext = path.join(dir, "extension");
  fs.cpSync(extensionDir(), ext, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  manifest.externally_connectable.matches.push(`http://localhost:${port}/*`);
  fs.writeFileSync(path.join(ext, "manifest.json"), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(path.join(dir, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  expect(worker.url()).toContain(EXTENSION_ID);
  const noah = await context.newPage();
  await noah.goto(`http://localhost:${port}/noah`);
  return { context, noah, worker, dir };
}

let requestSeq = 0;

/** One op as the Noah client sends it: a fresh requestId, plus `driver` when given. */
function op(noah: Page, message: Record<string, unknown>, driver?: string): Promise<Reply> {
  const full = { requestId: `lease-${Date.now()}-${++requestSeq}`, ...(driver ? { driver } : {}), ...message };
  return noah.evaluate(
    ([id, msg]) =>
      new Promise<Reply>((resolve) => {
        const rt = (globalThis as unknown as {
          chrome: { runtime: { sendMessage: (id: string, m: unknown, cb: (r: Reply) => void) => void } };
        }).chrome.runtime;
        rt.sendMessage(id as string, { source: "noah", ...(msg as object) }, (reply) => resolve(reply));
      }),
    [EXTENSION_ID, full] as const,
  );
}

/** The Noah group holding page "p" — the user's own tab — made from the worker (no consent popup). */
async function groupFixture(worker: Worker): Promise<void> {
  await worker.evaluate(async (url) => {
    const c = (globalThis as unknown as { chrome: any }).chrome;
    const tab = await c.tabs.create({ url, active: true });
    const groupId = await c.tabs.group({ tabIds: [tab.id] });
    await c.tabGroups.update(groupId, { title: "Noah" });
    await new Promise((r) => setTimeout(r, 800));
  }, `http://localhost:${port}/page-p.html`);
}

const currentOf = (reply: Reply) => reply.tabs?.find((tab) => tab.current);
const BUSY = "is being driven by another of the user's Noah conversations right now";

async function searchUid(noah: Page, driver?: string): Promise<string> {
  const found = await op(noah, { op: "find", role: "textbox" }, driver);
  expect(found.ok, found.message).toBe(true);
  return /\[(e\d+)\] textbox/.exec(String(found.snapshot))![1];
}

test.describe("per-conversation working tabs in the real extension", () => {
  test.setTimeout(180_000);

  test("two drivers: own tabs, refusals on the other's tab, the grace, and the legacy slot", async () => {
    const { context, noah, worker, dir } = await launch();
    try {
      expect((await op(noah, { op: "setAllowedOrigins", patterns: ["localhost"] })).ok).toBe(true);
      await groupFixture(worker);

      // A opens its own tab and acts in it.
      const aOpened = await op(noah, { op: "new_tab", url: `http://localhost:${port}/page-a.html` }, "conv-A");
      expect(aOpened.ok, aOpened.message).toBe(true);
      const tabA = currentOf(aOpened)!;
      expect(tabA.url).toContain("page-a.html");
      const uidA = await searchUid(noah, "conv-A");
      const typedA = await op(noah, { op: "type", uid: uidA, text: "alpha", clear: true }, "conv-A");
      expect(typedA.ok, typedA.message).toBe(true);
      expect(String(typedA.snapshot)).toContain('"alpha"');

      // B may not use A's tab in ANY way: select, act through A's uid, close.
      const bSelect = await op(noah, { op: "select_tab", tabId: tabA.tabId }, "conv-B");
      expect(bSelect.ok).toBe(false);
      expect(String(bSelect.message)).toContain(`Tab ${tabA.tabId} ${BUSY}`);
      expect(String(bSelect.message)).toContain("mcp__browser__new_tab");
      const bUid = await op(noah, { op: "type", uid: uidA, text: "intruder", clear: true }, "conv-B");
      expect(bUid.ok).toBe(false);
      expect(String(bUid.message)).toContain(BUSY);
      const bClose = await op(noah, { op: "close_tab", tabId: tabA.tabId }, "conv-B");
      expect(bClose.ok).toBe(false);
      expect(String(bClose.message)).toContain(BUSY);
      // list_tabs: A's tab is BUSY for B and B's working tab is not A's.
      const bList = await op(noah, { op: "list_tabs" }, "conv-B");
      expect(bList.ok, bList.message).toBe(true);
      const aSeenByB = bList.tabs!.find((tab) => tab.tabId === tabA.tabId)!;
      expect(aSeenByB.busy).toBe(true);
      expect(aSeenByB.current).toBe(false);
      // …while A sees its own tab as current and not busy.
      const aList = await op(noah, { op: "list_tabs" }, "conv-A");
      const aSeenByA = aList.tabs!.find((tab) => tab.tabId === tabA.tabId)!;
      expect(aSeenByA).toMatchObject({ current: true });
      expect(aSeenByA.busy).toBeUndefined();

      // B's new_tab works and leaves A's working tab exactly where it was.
      const bOpened = await op(noah, { op: "new_tab", url: `http://localhost:${port}/page-b.html` }, "conv-B");
      expect(bOpened.ok, bOpened.message).toBe(true);
      const tabB = currentOf(bOpened)!;
      expect(tabB.url).toContain("page-b.html");
      expect(tabB.tabId).not.toBe(tabA.tabId);
      // Both conversations act AT THE SAME TIME, each on its own tab — nothing interleaves.
      const uidB = await searchUid(noah, "conv-B");
      const [againA, typedB] = await Promise.all([
        op(noah, { op: "type", uid: uidA, text: "alpha-two", clear: true }, "conv-A"),
        op(noah, { op: "type", uid: uidB, text: "beta", clear: true }, "conv-B"),
      ]);
      expect(againA.ok, againA.message).toBe(true);
      expect(typedB.ok, typedB.message).toBe(true);
      const aSnap = await op(noah, { op: "snapshot" }, "conv-A");
      expect(aSnap.url).toContain("page-a.html");
      expect(String(aSnap.snapshot)).toContain('"alpha-two"');
      expect(String(aSnap.snapshot)).not.toContain("beta");
      const bSnap = await op(noah, { op: "snapshot" }, "conv-B");
      expect(bSnap.url).toContain("page-b.html");
      expect(String(bSnap.snapshot)).toContain('"beta"');

      // read_url's reader tab disturbs neither driver's working tab.
      const read = await op(noah, { op: "read_url", url: `http://localhost:${port}/data.json` }, "conv-B");
      expect(read.ok, read.message).toBe(true);
      expect(currentOf(await op(noah, { op: "list_tabs" }, "conv-A"))!.tabId).toBe(tabA.tabId);
      expect(currentOf(await op(noah, { op: "list_tabs" }, "conv-B"))!.tabId).toBe(tabB.tabId);

      // An op WITHOUT driver (an older client/server) still works: the legacy
      // slot falls back to the oldest tab nobody else is driving — the user's p.
      const legacy = await op(noah, { op: "snapshot" });
      expect(legacy.ok, legacy.message).toBe(true);
      expect(legacy.url).toContain("page-p.html");
      expect(String(legacy.note)).toContain("2 tabs another of the user's conversations is driving were skipped");

      // A third conversation with no tab of its own: every tab is leased → refused, pointed at new_tab.
      const cSnap = await op(noah, { op: "snapshot" }, "conv-C");
      expect(cSnap.ok).toBe(false);
      expect(String(cSnap.message)).toContain("every tab in the Noah group is being driven by another");
      expect(String(cSnap.message)).toContain("mcp__browser__new_tab");

      // The lease outlives the worker's idle stop: it is mirrored in storage.session.
      const mirrored = await worker.evaluate(async () => {
        const c = (globalThis as unknown as { chrome: any }).chrome;
        return (await c.storage.session.get(["tabLeases", "workingTabsByDriver"])) as Record<string, any>;
      });
      expect(mirrored.tabLeases[tabA.tabId].driver).toBe("conv-A");
      expect(mirrored.workingTabsByDriver).toMatchObject({ "conv-A": Number(tabA.tabId), "conv-B": Number(tabB.tabId) });

      // After the 60 s grace A's tab is free: B may take it — and now A is the one refused.
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      const bTakes = await op(noah, { op: "select_tab", tabId: tabA.tabId }, "conv-B");
      expect(bTakes.ok, bTakes.message).toBe(true);
      const bOnA = await op(noah, { op: "snapshot" }, "conv-B");
      expect(bOnA.ok, bOnA.message).toBe(true);
      expect(bOnA.url).toContain("page-a.html");
      const aRefused = await op(noah, { op: "snapshot" }, "conv-A");
      expect(aRefused.ok).toBe(false);
      expect(String(aRefused.message)).toContain(`Tab ${tabA.tabId} ${BUSY}`);
      // A's way out works: its own new tab.
      const aAgain = await op(noah, { op: "new_tab", url: `http://localhost:${port}/page-a.html` }, "conv-A");
      expect(aAgain.ok, aAgain.message).toBe(true);
      expect(currentOf(aAgain)!.tabId).not.toBe(tabA.tabId);
    } finally {
      await context.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
