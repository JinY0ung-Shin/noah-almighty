import { Worker } from "node:worker_threads";

/**
 * Server-side mermaid syntax check for `mcp__canvas__show` (#69). The canvas
 * renders CLIENT-side, so a parse error used to surface only as a red banner the
 * avatar never saw — it couldn't fix its own diagram. Parsing here with the SAME
 * `mermaid` package the client bundles turns that into a tool error the model
 * reads and retries on.
 *
 * Runs in a worker thread, not in-process: mermaid's label sanitizer calls
 * DOMPurify, which loads as an empty shell under Node (no DOM), so the worker
 * stubs it with a pass-through. That stub must never leak into the server's own
 * module graph, and a pathological source must never stall the event loop.
 *
 * FAIL-OPEN: anything that isn't a verdict on the source (worker failed to boot,
 * self-test failed, timeout, a DOM-dependent diagram type throwing a
 * TypeError/ReferenceError) is `unverified` and the canvas is shown as before —
 * the check may only ever add a correct rejection, never block a valid diagram.
 */
export type MermaidCheckResult = { ok: true } | { ok: false; error: string } | { ok: "unverified"; reason: string };

const CHECK_TIMEOUT_MS = 5000;
const IDLE_SHUTDOWN_MS = 60_000;
const MAX_ERROR_CHARS = 800;

// Exercises the quoted-label path that goes through the DOMPurify stub, so a
// mermaid upgrade that breaks the worker environment disables the check
// instead of rejecting every valid diagram.
const SELF_TEST_SOURCE = 'flowchart LR\n  A["self (test)"] -->|"edge (label)"| B';

// Module-agnostic: Node may evaluate an `eval` worker as CommonJS OR as ESM
// (it follows the parent's --input-type), so no require, no static import and
// no top-level await — everything loads via import() inside an async IIFE, the
// packages from the absolute URLs the main thread resolved.
const WORKER_SOURCE = `
(async () => {
const { parentPort, workerData } = await import("node:worker_threads");
const ready = (async () => {
  const purify = (await import(workerData.dompurifyUrl)).default;
  // This thread only PARSES — nothing it sanitizes is ever rendered.
  if (typeof purify.sanitize !== "function") {
    purify.sanitize = (s) => String(s);
    purify.addHook = () => {};
  }
  const mermaid = (await import(workerData.mermaidUrl)).default;
  // Mirrors CanvasTab.svelte's initialize so both sides parse alike.
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false });
  return mermaid;
})();
let chain = Promise.resolve();
parentPort.on("message", ({ id, source }) => {
  chain = chain.then(async () => {
    let mermaid;
    try {
      mermaid = await ready;
    } catch (e) {
      parentPort.postMessage({ id, kind: "env", error: String(e && e.message ? e.message : e) });
      return;
    }
    try {
      await mermaid.parse(source);
      parentPort.postMessage({ id, kind: "ok" });
    } catch (e) {
      const env = e instanceof TypeError || e instanceof ReferenceError;
      parentPort.postMessage({ id, kind: env ? "env" : "syntax", error: String(e && e.message ? e.message : e) });
    }
  });
});
})();
`;

// `local`: synthesized on this side (timeout, worker stopped/crashed), not a
// verdict the worker itself sent — such a failure may be transient.
type WorkerReply = { id: number; kind: "ok" | "syntax" | "env"; error?: string; local?: true };

let worker: Worker | null = null;
let selfTest: Promise<boolean> | null = null;
let disabled = false;
let nextId = 1;
let idleTimer: NodeJS.Timeout | null = null;
const pending = new Map<number, (reply: WorkerReply) => void>();

function resetWorker(): void {
  const w = worker;
  worker = null;
  selfTest = null;
  for (const resolve of pending.values()) resolve({ id: 0, kind: "env", error: "mermaid check worker stopped", local: true });
  pending.clear();
  if (w) void w.terminate();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { mermaidUrl: import.meta.resolve("mermaid"), dompurifyUrl: import.meta.resolve("dompurify") },
    // Content is capped at 20k chars; this only bounds a runaway parse.
    resourceLimits: { maxOldGenerationSizeMb: 256 },
  });
  w.on("message", (reply: WorkerReply) => {
    const resolve = pending.get(reply.id);
    if (!resolve) return;
    pending.delete(reply.id);
    if (pending.size === 0) w.unref();
    resolve(reply);
  });
  w.on("error", (err) => {
    console.warn("[mermaid-check] worker error:", err);
    if (worker === w) resetWorker();
  });
  // Held only while a check is in flight, so an idle worker never keeps the
  // process alive. Unref AFTER the listeners: attaching "message" re-refs it.
  w.unref();
  worker = w;
  return w;
}

function ask(source: string): Promise<WorkerReply> {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      // A parse that hangs would hold every later check behind it — start fresh.
      if (worker === w) resetWorker();
      resolve({ id, kind: "env", error: `timed out after ${CHECK_TIMEOUT_MS} ms`, local: true });
    }, CHECK_TIMEOUT_MS);
    timer.unref();
    pending.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    w.ref();
    w.postMessage({ id, source });
  });
}

function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size === 0) resetWorker();
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref();
}

/** Parse `source` with mermaid; see the module comment for the fail-open contract. */
export async function checkMermaidSyntax(source: string): Promise<MermaidCheckResult> {
  if (disabled) return { ok: "unverified", reason: "mermaid check disabled (self-test failed)" };
  try {
    selfTest ??= ask(SELF_TEST_SOURCE).then((reply) => {
      if (reply.kind === "ok") return true;
      // A worker that REPORTS it cannot load mermaid or parse the known-good
      // sample fails the same way every time; a timeout or a crashed/killed
      // worker (OOM, thread limits on a busy host) gets a fresh try next call.
      if (!reply.local) disabled = true;
      console.warn("[mermaid-check] self-test failed; canvases skip the syntax check:", reply.error);
      return false;
    });
    if (!(await selfTest)) return { ok: "unverified", reason: "mermaid check self-test failed" };
    const reply = await ask(source);
    if (reply.kind === "ok") return { ok: true };
    if (reply.kind === "syntax") return { ok: false, error: (reply.error ?? "").slice(0, MAX_ERROR_CHARS) };
    return { ok: "unverified", reason: reply.error ?? "unknown" };
  } catch (err) {
    return { ok: "unverified", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    scheduleIdleShutdown();
  }
}
