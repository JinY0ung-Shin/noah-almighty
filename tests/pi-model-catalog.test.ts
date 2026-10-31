import { describe, expect, it, vi } from "vitest";
import logger from "../src/server/logger.js";
import {
  PI_MODEL_CATALOG_TTL_MS,
  createPiModelCatalog,
  warnRetiredModelMapEnv,
} from "../src/server/agent/pi/modelCatalog.js";
import type { PiModel } from "../src/server/agent/pi/responsesClient.js";

// pi-gateway's live model list (agent/pi/modelCatalog.ts): the only model
// source the composer, the admin override/vision policy and every run read.

/** A scripted `GET /v1/models`: each call takes the next answer (a list, or an Error to throw). */
function scriptedPi(answers: (PiModel[] | Error)[]) {
  const calls = { count: 0 };
  const client = {
    listModels: vi.fn(async () => {
      const answer = answers[Math.min(calls.count++, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
  return { client, calls };
}

describe("pi model catalog", () => {
  it("maps pi's list (owned_by → server, the default flag), drops blanks and duplicates, and caches it for the TTL", async () => {
    let now = 1_000;
    const { client } = scriptedPi([
      [{ id: "deepseek/v3", ownedBy: "deepseek" }, { id: "qwen/coder", default: true }, { id: " " }, { id: "deepseek/v3" }],
      [{ id: "glm-4" }],
    ]);
    const catalog = createPiModelCatalog(client, { now: () => now });
    expect(catalog.peek()).toEqual([]);
    const first = [
      { id: "deepseek/v3", server: "deepseek" },
      { id: "qwen/coder", server: null, default: true },
    ];
    expect(await catalog.list()).toEqual(first);
    expect(catalog.peek()).toEqual(first);
    now += PI_MODEL_CATALOG_TTL_MS - 1;
    expect(await catalog.list()).toEqual(first);
    expect(client.listModels).toHaveBeenCalledTimes(1);
    // Past the TTL the next lookup refreshes.
    now += 1;
    expect(await catalog.list()).toEqual([{ id: "glm-4", server: null }]);
    expect(client.listModels).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch between concurrent lookups", async () => {
    let release!: (models: PiModel[]) => void;
    const client = { listModels: vi.fn(() => new Promise<PiModel[]>((resolve) => (release = resolve))) };
    const catalog = createPiModelCatalog(client);
    const lookups = Promise.all([catalog.list(), catalog.snapshot(), catalog.list()]);
    release([{ id: "m1" }]);
    const [a, b, c] = await lookups;
    expect(client.listModels).toHaveBeenCalledTimes(1);
    expect(a).toEqual([{ id: "m1", server: null }]);
    expect(b).toEqual({ models: [{ id: "m1", server: null }], available: true });
    expect(c).toEqual(a);
  });

  it("keeps the last good list when a refresh fails (stale-on-error), and retries later", async () => {
    let now = 0;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const { client } = scriptedPi([[{ id: "m1" }], new Error("ECONNREFUSED"), [{ id: "m2" }]]);
      const catalog = createPiModelCatalog(client, { now: () => now });
      await catalog.list();
      now += PI_MODEL_CATALOG_TTL_MS;
      // The refresh fails: still the last good list, still "available" for writes.
      expect(await catalog.snapshot()).toEqual({ models: [{ id: "m1", server: null }], available: true });
      // A failed fetch is not retried on every lookup…
      expect(await catalog.list()).toEqual([{ id: "m1", server: null }]);
      expect(client.listModels).toHaveBeenCalledTimes(2);
      // …but soon after.
      now += 5_000;
      expect(await catalog.list()).toEqual([{ id: "m2", server: null }]);
    } finally {
      warn.mockRestore();
    }
  });

  it("is empty and UNAVAILABLE when pi has never answered", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      const { client } = scriptedPi([new Error("ENOTFOUND")]);
      const catalog = createPiModelCatalog(client);
      expect(await catalog.snapshot()).toEqual({ models: [], available: false });
      expect(await catalog.list()).toEqual([]);
      expect(catalog.peek()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("is always empty — and available — on the local stub (no pi client)", async () => {
    const catalog = createPiModelCatalog(null);
    expect(await catalog.snapshot()).toEqual({ models: [], available: true });
    expect(catalog.peek()).toEqual([]);
  });
});

describe("PI_MODEL_MAP retirement", () => {
  it("warns once per boot while PI_MODEL_MAP is still set, and never reads it", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    try {
      warnRetiredModelMapEnv({});
      warnRetiredModelMapEnv({ PI_MODEL_MAP: "  " });
      expect(warn).not.toHaveBeenCalled();
      warnRetiredModelMapEnv({ PI_MODEL_MAP: '{"opus":"m1"}' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("PI_MODEL_MAP is set but ignored");
    } finally {
      warn.mockRestore();
    }
  });
});
