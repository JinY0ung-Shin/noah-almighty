import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — plain ES module shipped in the extension, no type declarations
import * as leasesModule from "../extension/tabLeases.js";

// The pure half of per-conversation working tabs (extension 0.29.0): the lease
// rules, the per-driver working-tab map, the fallback choice and the per-tab
// mutex. background.js only wires these to chrome.* — the real-browser proof is
// tests/visual/tab-leases.spec.ts.
const {
  LEGACY_DRIVER,
  DRIVER_MAX_CHARS,
  TAB_LEASE_GRACE_MS,
  WORKING_TABS_MAX,
  driverOf,
  leaseHolder,
  leaseConflict,
  beginLease,
  endLease,
  touchLease,
  pruneLeases,
  serializeLeases,
  restoreLeases,
  setWorkingTab,
  forgetWorkingTab,
  serializeWorkingTabs,
  restoreWorkingTabs,
  pickFallbackTab,
  busyTabMessage,
  ALL_TABS_BUSY_MESSAGE,
  createTabMutex,
} = leasesModule as Record<string, any>;

const T0 = 1_000_000;

describe("driverOf", () => {
  it("reads the wire driver, bounded, and maps a missing one to the legacy slot", () => {
    expect(driverOf({ driver: "conv-a" })).toBe("conv-a");
    expect(driverOf({ driver: "x".repeat(400) })).toHaveLength(DRIVER_MAX_CHARS);
    for (const message of [{}, { driver: "" }, { driver: 7 }, { driver: null }, null, undefined]) {
      expect(driverOf(message)).toBe(LEGACY_DRIVER);
    }
  });
});

describe("leases", () => {
  it("holds a tab while an op runs and for the grace after it, then frees it", () => {
    const leases = new Map();
    expect(leaseHolder(leases, 5, T0)).toBeNull();
    beginLease(leases, 5, "A", T0);
    expect(leaseHolder(leases, 5, T0 + 10 * TAB_LEASE_GRACE_MS)).toBe("A"); // running: no expiry
    endLease(leases, 5, "A", T0 + 1000);
    expect(leaseHolder(leases, 5, T0 + 1000 + TAB_LEASE_GRACE_MS - 1)).toBe("A");
    expect(leaseHolder(leases, 5, T0 + 1000 + TAB_LEASE_GRACE_MS)).toBeNull();
  });

  it("refuses ANOTHER driver with the time left, never the holder itself", () => {
    const leases = new Map();
    beginLease(leases, 5, "A", T0);
    // While A's op runs, B is told the whole grace.
    expect(leaseConflict(leases, 5, "B", T0 + 5)).toEqual({ holder: "A", freeInMs: TAB_LEASE_GRACE_MS });
    expect(leaseConflict(leases, 5, "A", T0 + 5)).toBeNull();
    endLease(leases, 5, "A", T0 + 1000);
    expect(leaseConflict(leases, 5, "B", T0 + 21_000)).toEqual({ holder: "A", freeInMs: TAB_LEASE_GRACE_MS - 20_000 });
    // After the grace B may take it, and then A is the one refused.
    expect(leaseConflict(leases, 5, "B", T0 + 1000 + TAB_LEASE_GRACE_MS)).toBeNull();
    beginLease(leases, 5, "B", T0 + 1000 + TAB_LEASE_GRACE_MS);
    expect(leaseConflict(leases, 5, "A", T0 + 1000 + TAB_LEASE_GRACE_MS)?.holder).toBe("B");
  });

  it("counts overlapping ops of one driver and starts the grace only when the last ends", () => {
    const leases = new Map();
    beginLease(leases, 5, "A", T0);
    beginLease(leases, 5, "A", T0 + 1);
    endLease(leases, 5, "A", T0 + 2);
    expect(leaseHolder(leases, 5, T0 + 2 + 5 * TAB_LEASE_GRACE_MS)).toBe("A"); // one still running
    endLease(leases, 5, "A", T0 + 3);
    expect(leaseHolder(leases, 5, T0 + 3 + TAB_LEASE_GRACE_MS)).toBeNull();
    // An end from a driver that does not hold it changes nothing.
    beginLease(leases, 6, "A", T0);
    endLease(leases, 6, "B", T0);
    expect(leases.get(6).running).toBe(1);
  });

  it("touchLease claims a tab with nothing running (new_tab, select_tab)", () => {
    const leases = new Map();
    touchLease(leases, 9, "A", T0);
    expect(leaseConflict(leases, 9, "B", T0 + 1)?.holder).toBe("A");
    expect(leaseHolder(leases, 9, T0 + TAB_LEASE_GRACE_MS)).toBeNull();
  });

  it("prunes expired leases and round-trips the storage mirror grace-only", () => {
    const leases = new Map();
    beginLease(leases, 1, "A", T0); // running
    touchLease(leases, 2, "B", T0); // grace only
    touchLease(leases, 3, "C", T0 - 2 * TAB_LEASE_GRACE_MS); // long expired
    expect(pruneLeases(leases, T0)).toBe(true);
    expect([...leases.keys()].sort()).toEqual([1, 2]);

    const plain = serializeLeases(leases);
    expect(plain).toEqual({
      "1": { driver: "A", until: T0 + TAB_LEASE_GRACE_MS },
      "2": { driver: "B", until: T0 + TAB_LEASE_GRACE_MS },
    });
    const restored = restoreLeases({ ...plain, "4": { driver: "D", until: T0 - 1 }, x: { driver: "E", until: T0 + 5 }, "5": "junk" }, T0);
    expect([...restored.keys()].sort()).toEqual([1, 2]);
    // A restarted worker ran nothing: restored leases are grace-only.
    expect(restored.get(1)).toEqual({ driver: "A", running: 0, until: T0 + TAB_LEASE_GRACE_MS });
    expect(restoreLeases(null, T0).size).toBe(0);
  });
});

describe("working tabs per driver", () => {
  it("keeps one pointer per driver, bounded, and forgets a closed tab everywhere", () => {
    const tabs = new Map();
    setWorkingTab(tabs, "A", 11);
    setWorkingTab(tabs, "B", 22);
    setWorkingTab(tabs, LEGACY_DRIVER, 11);
    expect(serializeWorkingTabs(tabs)).toEqual({ A: 11, B: 22, "": 11 });
    setWorkingTab(tabs, "B", null);
    expect(tabs.has("B")).toBe(false);
    expect(forgetWorkingTab(tabs, 11)).toBe(true);
    expect(tabs.size).toBe(0);
    expect(forgetWorkingTab(tabs, 11)).toBe(false);

    for (let i = 0; i < WORKING_TABS_MAX + 5; i += 1) setWorkingTab(tabs, `d${i}`, i);
    expect(tabs.size).toBe(WORKING_TABS_MAX);
    expect(tabs.has("d0")).toBe(false); // the stalest pointer went first
    setWorkingTab(tabs, "d5", 99); // re-set = freshest again
    setWorkingTab(tabs, "new", 100);
    expect(tabs.has("d5")).toBe(true);
    expect(tabs.has("d6")).toBe(false);
  });

  it("migrates the pre-0.29.0 single pointer into the LEGACY slot only", () => {
    expect(serializeWorkingTabs(restoreWorkingTabs(undefined, 42))).toEqual({ "": 42 });
    // A map already holding a legacy pointer wins over the stale single key.
    expect(serializeWorkingTabs(restoreWorkingTabs({ "": 7, A: 8 }, 42))).toEqual({ "": 7, A: 8 });
    expect(serializeWorkingTabs(restoreWorkingTabs({ A: "nope", B: 1.5, C: 3 }, "x"))).toEqual({ C: 3 });
  });
});

describe("pickFallbackTab", () => {
  it("skips tabs another driver is using and prefers ones nobody points at", () => {
    const leases = new Map();
    const working = new Map();
    // 1 = oldest. A leases 1; B points at 2 (lease expired); 3 is nobody's.
    beginLease(leases, 1, "A", T0);
    working.set("A", 1);
    working.set("B", 2);
    expect(pickFallbackTab([1, 2, 3], "C", working, leases, T0)).toBe(3);
    // With only tabs pointed at by others left, an UNLEASED one is still usable.
    expect(pickFallbackTab([1, 2], "C", working, leases, T0)).toBe(2);
    // The holder itself may fall back onto its own leased tab.
    expect(pickFallbackTab([1], "A", working, leases, T0)).toBe(1);
    // Everything leased by others → null (the caller refuses with ALL_TABS_BUSY_MESSAGE).
    touchLease(leases, 2, "B", T0);
    expect(pickFallbackTab([1, 2], "C", working, leases, T0)).toBeNull();
    // Legacy ops are a driver like any other here.
    expect(pickFallbackTab([1, 2, 3], LEGACY_DRIVER, working, leases, T0)).toBe(3);
  });
});

describe("refusal text", () => {
  it("names the tab, forbids touching it, points at new_tab and says how long to wait", () => {
    const message = busyTabMessage(123, 41_200);
    expect(message).toBe(
      "Tab 123 is being driven by another of the user's Noah conversations right now, so this conversation may " +
        "not use it — do not touch it. Open your own tab with mcp__browser__new_tab and continue there; only if " +
        "you need that exact tab, wait (it frees about 42s after that conversation's last browser action) and retry.",
    );
    expect(busyTabMessage(1, 0)).toContain("about 1s");
    expect(ALL_TABS_BUSY_MESSAGE).toContain("mcp__browser__new_tab");
  });
});

describe("createTabMutex", () => {
  it("serializes ops on ONE tab and lets other tabs run at once", async () => {
    const mutex = createTabMutex();
    const order: string[] = [];
    const releaseA = await mutex.acquire(1, 1000);
    order.push("A in");
    const waitingB = mutex.acquire(1, 1000).then((release: () => void) => {
      order.push("B in");
      return release;
    });
    const releaseOther = await mutex.acquire(2, 1000); // another tab is not blocked
    order.push("other in");
    await Promise.resolve();
    expect(order).toEqual(["A in", "other in"]);
    releaseA();
    const releaseB = await waitingB;
    expect(order).toEqual(["A in", "other in", "B in"]);
    releaseB();
    releaseOther();
    releaseB(); // idempotent
    expect(mutex.busy(1)).toBe(false);
    expect(mutex.busy(2)).toBe(false);
  });

  it("gives up a bounded wait without stranding the ops queued behind it", async () => {
    vi.useFakeTimers();
    try {
      const mutex = createTabMutex();
      const holder = await mutex.acquire(1, 1000);
      const timedOut = mutex.acquire(1, 500);
      const third = mutex.acquire(1, 5000);
      const outcome = timedOut.then(
        () => "acquired",
        (error: Error) => error.message,
      );
      await vi.advanceTimersByTimeAsync(600);
      expect(await outcome).toContain("did not finish within 1s");
      holder();
      const release = await third;
      expect(typeof release).toBe("function");
      release();
      expect(mutex.busy(1)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
