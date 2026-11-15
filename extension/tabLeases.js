/**
 * The PURE half of per-conversation working tabs (0.29.0): which tab each
 * DRIVER (one Noah conversation) works in, which tab a driver is using right
 * now (a LEASE), and the per-tab mutex that keeps two ops off one tab at the
 * same instant. No chrome.* here — background.js owns the storage mirrors and
 * the tab queries, and passes plain Maps and the clock in, so every rule below
 * is unit-tested without a browser (tests/browser-tab-leases.test.ts).
 *
 * Why it exists: before 0.29.0 the whole browser had ONE working tab. Two of a
 * user's conversations driving the browser at once (a run that keeps going
 * after the user switched conversations, or two split panes) shared it: one
 * conversation's new_tab re-pointed the other's working tab, uids hit the other
 * conversation's page, typing interleaved — silently. Now every op relayed from
 * a run carries `driver` (the run's conversation id, set server-side; the model
 * never chooses it), each driver keeps its own working tab, and an op that
 * would act on a tab ANOTHER driver is using is REFUSED, never queued.
 *
 * Language split: the strings here are model input, so English.
 */

/**
 * The slot an op WITHOUT `driver` uses — an older Noah client or server. Every
 * such op shares this one slot, which is exactly the pre-0.29.0 behaviour (one
 * working tab for everything that does not say who it is).
 */
export const LEGACY_DRIVER = "";

/** Bound on the driver key; the relay already caps it, this is the assertion. */
export const DRIVER_MAX_CHARS = 128;

/**
 * How long a tab stays leased to its driver after that driver's LAST op ends.
 *
 * The lease must cover the model's think time between two ops of one task —
 * reading a big snapshot and deciding the next click is routinely 5–30 s, and a
 * slow model with long reasoning reaches ~45 s — or another conversation could
 * slip into the tab mid-task, which is the exact failure this exists for. It
 * must NOT outlive a finished task by much either: a tab whose conversation is
 * done should be free for another one soon, and the refusal tells the waiting
 * driver how long it has left. 60 s is the top of that think-time range and the
 * shortest wait a person notices as "a minute"; the clock restarts at every op,
 * so a long task holds its tab for as long as it keeps acting.
 */
export const TAB_LEASE_GRACE_MS = 60_000;

/** How many drivers' working tabs are remembered (the oldest pointer drops first). */
export const WORKING_TABS_MAX = 50;

/** The driver key an op carries, or LEGACY_DRIVER for one that carries none. */
export function driverOf(message) {
  const raw = message?.driver;
  if (typeof raw !== "string" || !raw) return LEGACY_DRIVER;
  return raw.slice(0, DRIVER_MAX_CHARS);
}

// ---------------------------------------------------------------- leases
//
// leases: Map<tabId, { driver, running, until }>
//   running — ops of `driver` executing on the tab right now (module-only; a
//             restarted worker has nothing running)
//   until   — epoch ms the grace ends after the last op finished

/** The driver holding a LIVE lease on the tab, or null when the tab is free. */
export function leaseHolder(leases, tabId, now) {
  const lease = leases.get(tabId);
  if (!lease) return null;
  if (lease.running > 0 || lease.until > now) return lease.driver;
  return null;
}

/**
 * Would `driver` acting on `tabId` collide with another driver? Answers null
 * (go ahead) or `{ holder, freeInMs }` — freeInMs is the grace left, or the
 * whole grace while the holder still has an op running.
 */
export function leaseConflict(leases, tabId, driver, now, graceMs = TAB_LEASE_GRACE_MS) {
  const holder = leaseHolder(leases, tabId, now);
  if (holder === null || holder === driver) return null;
  const lease = leases.get(tabId);
  const freeInMs = lease.running > 0 ? graceMs : Math.max(0, lease.until - now);
  return { holder, freeInMs };
}

/**
 * An op of `driver` starts on the tab. Callers check leaseConflict FIRST; this
 * takes the lease over regardless (an expired lease of another driver is simply
 * replaced), so the order is: check → begin.
 */
export function beginLease(leases, tabId, driver, now, graceMs = TAB_LEASE_GRACE_MS) {
  const lease = leases.get(tabId);
  if (lease && lease.driver === driver) {
    lease.running += 1;
    lease.until = Math.max(lease.until, now + graceMs);
  } else {
    leases.set(tabId, { driver, running: 1, until: now + graceMs });
  }
}

/** An op of `driver` on the tab ended: the grace starts now. */
export function endLease(leases, tabId, driver, now, graceMs = TAB_LEASE_GRACE_MS) {
  const lease = leases.get(tabId);
  if (!lease || lease.driver !== driver) return;
  lease.running = Math.max(0, lease.running - 1);
  lease.until = now + graceMs;
}

/**
 * Lease a tab with nothing running on it — new_tab's freshly created tab, so no
 * other driver can take it between the create and the first op on it.
 */
export function touchLease(leases, tabId, driver, now, graceMs = TAB_LEASE_GRACE_MS) {
  const lease = leases.get(tabId);
  if (lease && lease.driver === driver) {
    lease.until = Math.max(lease.until, now + graceMs);
  } else {
    leases.set(tabId, { driver, running: 0, until: now + graceMs });
  }
}

/** Drop expired leases (nothing running, grace over). Returns whether any went. */
export function pruneLeases(leases, now) {
  let changed = false;
  for (const [tabId, lease] of leases) {
    if (lease.running <= 0 && lease.until <= now) {
      leases.delete(tabId);
      changed = true;
    }
  }
  return changed;
}

/**
 * The storage.session mirror of the leases. `running` is NOT persisted: the
 * mirror exists for a worker that idled out between two ops of a task (MV3 stops
 * an idle worker after ~30 s, inside the grace), and a stopped worker was
 * running nothing — its leases restore as grace-only.
 */
export function serializeLeases(leases) {
  const plain = {};
  for (const [tabId, lease] of leases) plain[String(tabId)] = { driver: lease.driver, until: lease.until };
  return plain;
}

export function restoreLeases(plain, now) {
  const leases = new Map();
  if (!plain || typeof plain !== "object") return leases;
  for (const [key, value] of Object.entries(plain)) {
    const tabId = Number(key);
    if (!Number.isInteger(tabId) || !value || typeof value !== "object") continue;
    if (typeof value.driver !== "string" || typeof value.until !== "number") continue;
    if (value.until <= now) continue;
    leases.set(tabId, { driver: value.driver.slice(0, DRIVER_MAX_CHARS), running: 0, until: value.until });
  }
  return leases;
}

// ---------------------------------------------------------- working tabs
//
// workingTabs: Map<driver, tabId>, insertion-ordered so the bound drops the
// pointer nobody has set for longest.

/** Point `driver` at a tab, or forget its pointer with null. */
export function setWorkingTab(workingTabs, driver, tabId, max = WORKING_TABS_MAX) {
  workingTabs.delete(driver); // re-insert so the bound keeps the freshest
  if (tabId == null) return;
  workingTabs.set(driver, tabId);
  while (workingTabs.size > max) workingTabs.delete(workingTabs.keys().next().value);
}

/** A tab closed: no driver may keep pointing at it. Returns whether any did. */
export function forgetWorkingTab(workingTabs, tabId) {
  let changed = false;
  for (const [driver, id] of [...workingTabs]) {
    if (id === tabId) {
      workingTabs.delete(driver);
      changed = true;
    }
  }
  return changed;
}

export function serializeWorkingTabs(workingTabs) {
  return Object.fromEntries(workingTabs);
}

/**
 * Rebuild the map from the session mirror. `legacyTabId` is the pre-0.29.0
 * single pointer (`workingTabId`): it belonged to whatever drove the browser
 * last, which no driver can be named for, so it becomes the LEGACY slot's
 * pointer — an op without `driver` keeps the tab it had, and no conversation
 * inherits a tab it never chose (it falls back, announced, like any driver
 * with no working tab).
 */
export function restoreWorkingTabs(plain, legacyTabId) {
  const workingTabs = new Map();
  if (plain && typeof plain === "object") {
    for (const [driver, tabId] of Object.entries(plain)) {
      if (typeof tabId === "number" && Number.isInteger(tabId)) {
        workingTabs.set(driver.slice(0, DRIVER_MAX_CHARS), tabId);
      }
    }
  }
  if (typeof legacyTabId === "number" && !workingTabs.has(LEGACY_DRIVER)) {
    workingTabs.set(LEGACY_DRIVER, legacyTabId);
  }
  return workingTabs;
}

/**
 * The tab a driver with NO usable working tab falls back to, from the group's
 * tabs in age order (oldest first, as chrome.tabs.query returns them). Never a
 * tab another driver holds a live lease on; among the rest, a tab that is no
 * other driver's working tab beats one that is. Null when every tab is leased.
 */
export function pickFallbackTab(tabIds, driver, workingTabs, leases, now) {
  const free = tabIds.filter((id) => {
    const holder = leaseHolder(leases, id, now);
    return holder === null || holder === driver;
  });
  if (!free.length) return null;
  const pinnedElsewhere = new Set();
  for (const [other, id] of workingTabs) if (other !== driver) pinnedElsewhere.add(id);
  return free.find((id) => !pinnedElsewhere.has(id)) ?? free[0];
}

// -------------------------------------------------------------- messages

/** Whole seconds, at least 1, for a "frees in about N s" phrase. */
function seconds(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** The refusal for acting on (or selecting, or closing) a tab another driver is using. */
export function busyTabMessage(tabId, freeInMs) {
  return (
    `Tab ${tabId} is being driven by another of the user's Noah conversations right now, so this conversation ` +
    "may not use it — do not touch it. Open your own tab with mcp__browser__new_tab and continue there; only if " +
    `you need that exact tab, wait (it frees about ${seconds(freeInMs)}s after that conversation's last browser ` +
    "action) and retry."
  );
}

/** No working tab, and every tab in the group is leased by other drivers. */
export const ALL_TABS_BUSY_MESSAGE =
  "This conversation has no working tab yet, and every tab in the Noah group is being driven by another of the " +
  "user's Noah conversations right now — none of them may be used here. Open your own tab with " +
  "mcp__browser__new_tab (or wait a minute and retry).";

// ------------------------------------------------------------------ mutex

/**
 * A per-tab mutex: `acquire(tabId, waitMs)` resolves with a `release` function
 * once no other op holds the tab. The lease already refuses another DRIVER, so
 * what waits here is only ever the same driver's own overlap (a duplicate
 * delivery outliving the coalescer, a batch step and a single op) — the
 * guarantee is that two ops never EXECUTE on one tab at the same instant. A
 * wait is bounded (`waitMs`; a timeout rejects with an Error the op answers);
 * the HOLD is bounded by the caller (background.js claimTab), because a
 * renderer frozen by a native dialog can leave an op's CDP call pending forever.
 */
export function createTabMutex() {
  const tails = new Map(); // tabId -> promise that settles when the last holder releases
  return {
    acquire(tabId, timeoutMs) {
      const previous = tails.get(tabId) || Promise.resolve();
      let releaseNext;
      const mine = new Promise((resolve) => {
        releaseNext = resolve;
      });
      const tail = previous.then(() => mine);
      tails.set(tabId, tail);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseNext();
        if (tails.get(tabId) === tail) tails.delete(tabId);
      };
      return new Promise((resolve, reject) => {
        let timer = null;
        let timedOut = false;
        if (timeoutMs != null) {
          timer = setTimeout(() => {
            timedOut = true;
            // Give the slot up so the ops queued behind this one are not
            // stranded behind a waiter that already left.
            release();
            reject(
              new Error(
                `Another browser operation is still running on tab ${tabId} and did not finish within ` +
                  `${seconds(timeoutMs)}s. Wait for it, then retry.`,
              ),
            );
          }, timeoutMs);
        }
        previous.then(() => {
          if (timer) clearTimeout(timer);
          if (!timedOut) resolve(release);
        });
      });
    },
    /** Test/diagnostic: is anything holding or queued on the tab? */
    busy(tabId) {
      return tails.has(tabId);
    },
  };
}
