import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type CDPSession, type Page } from "@playwright/test";
// Kept on ONE line: @ts-expect-error only covers the line after it, and the
// error is raised on the module specifier — the LAST line of a wrapped import.
// @ts-expect-error — plain JS module that ships inside the extension bundle.
import { ariaExpandedOf, disclosureClickOutcome, pastedTextVanished, axValueAnswer } from "../../extension/axtree.js";

// EMPIRICAL evidence for the browser bridge's issue #64 (disclosure-trigger click
// verification) and #65 (paste appeared-then-vanished) notes, driven over raw CDP
// the way extension/background.js drives them, against a vanilla fixture that
// reproduces the two field contracts. The pure DECISIONS (ariaExpandedOf /
// disclosureClickOutcome / pastedTextVanished) are unit-tested in
// tests/browser-axtree.test.ts; this spec proves the CDP reads that feed them
// see what background.js assumes they see — a same-shaped guard as clear-ladder.

const FIXTURE = pathToFileURL(path.resolve("tests/visual/fixtures/disclosure-paste.html")).href;

/** MODIFIER_BITS.Control — background.js's paste modifier on Linux/Windows. */
const CONTROL = 2;

type Ref = { backendNodeId: number };

async function refFor(cdp: CDPSession, selector: string): Promise<Ref> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  return { backendNodeId: node.backendNodeId as number };
}

/** flatAttrs (background.js): CDP hands a node's attributes back flat + lowercased. */
async function attrsOf(cdp: CDPSession, ref: Ref): Promise<Record<string, string>> {
  const { node } = await cdp.send("DOM.describeNode", { backendNodeId: ref.backendNodeId, depth: 0 });
  const flat = (node.attributes ?? []) as string[];
  const attrs: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) attrs[String(flat[i]).toLowerCase()] = flat[i + 1];
  return attrs;
}

/** background.js clickPoint — byte-for-byte the move → press → release sequence. */
async function bridgeClick(cdp: CDPSession, ref: Ref) {
  const { quads } = await cdp.send("DOM.getContentQuads", { backendNodeId: ref.backendNodeId });
  const [x1, y1, , , x3, y3] = quads[0];
  const x = (x1 + x3) / 2;
  const y = (y1 + y3) / 2;
  const base = { x, y, button: "left" as const, clickCount: 1, pointerType: "mouse" as const };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...base });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...base });
}

/** The bridge's dispatchKey for a Ctrl+V paste: rawKeyDown (Control drops text) + keyUp. */
async function bridgePaste(cdp: CDPSession) {
  const key = { key: "v", code: "KeyV", windowsVirtualKeyCode: 86 };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: CONTROL, ...key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: CONTROL, ...key });
}

/** readAxValue (background.js) = axValueAnswer(one getPartialAXTree node). */
async function readAxValue(cdp: CDPSession, ref: Ref): Promise<string | null> {
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
    backendNodeId: ref.backendNodeId,
    fetchRelatives: false,
  });
  const list = (Array.isArray(nodes) ? nodes : []) as { backendDOMNodeId?: number }[];
  const own = list.find((n) => n.backendDOMNodeId === ref.backendNodeId) ?? list[0] ?? null;
  return axValueAnswer(own) as string | null;
}

const cpLen = (v: string | null) => (typeof v === "string" ? [...v].length : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(page: Page): Promise<CDPSession> {
  await page.goto(FIXTURE);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("Accessibility.enable");
  return cdp;
}

test.describe("issue #64 — disclosure click leaves an honest aria-expanded reading", () => {
  test("a real toggling trigger: the bridge click OPENS it (outcome 'opened')", async ({ page }) => {
    const cdp = await boot(page);
    const ref = await refFor(cdp, "#trigger-ok");
    const before = ariaExpandedOf(await attrsOf(cdp, ref));
    await bridgeClick(cdp, ref);
    await sleep(200); // DISCLOSURE_SETTLE_MS
    const after = ariaExpandedOf(await attrsOf(cdp, ref));
    expect(before).toBe(false);
    expect(after).toBe(true);
    expect(disclosureClickOutcome(before, after)).toBe("opened");
  });

  test("negative control: a trigger that swallows the click stays shut (outcome 'not-opened')", async ({ page }) => {
    const cdp = await boot(page);
    const ref = await refFor(cdp, "#trigger-dead");
    const before = ariaExpandedOf(await attrsOf(cdp, ref));
    await bridgeClick(cdp, ref);
    await sleep(200);
    const after = ariaExpandedOf(await attrsOf(cdp, ref));
    expect(before).toBe(false);
    expect(after).toBe(false);
    expect(disclosureClickOutcome(before, after)).toBe("not-opened");
  });

  test("a SECOND click closes the menu the first opened (outcome 'toggled-closed')", async ({ page }) => {
    const cdp = await boot(page);
    const ref = await refFor(cdp, "#trigger-ok");
    await bridgeClick(cdp, ref);
    await sleep(200);
    const before = ariaExpandedOf(await attrsOf(cdp, ref));
    await bridgeClick(cdp, ref);
    await sleep(200);
    const after = ariaExpandedOf(await attrsOf(cdp, ref));
    expect(before).toBe(true);
    expect(after).toBe(false);
    expect(disclosureClickOutcome(before, after)).toBe("toggled-closed");
  });
});

test.describe("issue #65 — paste grow-then-shrink is measurable over the bridge's read path", () => {
  test("an editor that DROPS the paste reads as vanished", async ({ page }) => {
    const cdp = await boot(page);
    const ref = await refFor(cdp, "#editor-drop");
    await cdp.send("DOM.focus", { backendNodeId: ref.backendNodeId });
    const before = cpLen(await readAxValue(cdp, ref));
    await bridgePaste(cdp);
    await sleep(150); // PASTE_PEAK_MS
    const peak = cpLen(await readAxValue(cdp, ref));
    await sleep(700 - 150); // to PASTE_SETTLE_MS
    const settled = cpLen(await readAxValue(cdp, ref));
    expect(before).toBe(0);
    expect(peak).toBe(40);
    expect(settled).toBe(0);
    expect(pastedTextVanished(before, peak, settled)).toBe(true);
  });

  test("negative control: an editor that KEEPS the paste does NOT read as vanished", async ({ page }) => {
    const cdp = await boot(page);
    const ref = await refFor(cdp, "#editor-keep");
    await cdp.send("DOM.focus", { backendNodeId: ref.backendNodeId });
    const before = cpLen(await readAxValue(cdp, ref));
    await bridgePaste(cdp);
    await sleep(150);
    const peak = cpLen(await readAxValue(cdp, ref));
    await sleep(700 - 150);
    const settled = cpLen(await readAxValue(cdp, ref));
    expect(before).toBe(0);
    expect(peak).toBe(40);
    expect(settled).toBe(40);
    expect(pastedTextVanished(before, peak, settled)).toBe(false);
  });
});
